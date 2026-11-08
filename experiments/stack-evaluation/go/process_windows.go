package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type controllerLease struct{ handle windows.Handle }

func (lease *controllerLease) Close() error {
	if lease.handle == windows.InvalidHandle {
		return nil
	}
	err := windows.CloseHandle(lease.handle)
	lease.handle = windows.InvalidHandle
	return err
}
func acquireControllerLease(dbPath string) (*controllerLease, error) {
	lockPath, err := windows.UTF16PtrFromString(dbPath + ".controller.lock")
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(lockPath, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, errors.New("controller lease unavailable")
	}
	lease := &controllerLease{handle: handle}
	if info, er := os.Stat(dbPath); er == nil {
		if !info.Mode().IsRegular() {
			lease.Close()
			return nil, errors.New("database must be regular")
		}
		file, er := os.Open(dbPath)
		if er != nil {
			lease.Close()
			return nil, er
		}
		var identity windows.ByHandleFileInformation
		er = windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &identity)
		file.Close()
		if er != nil || identity.NumberOfLinks != 1 {
			lease.Close()
			return nil, errors.New("hardlinked database unsupported")
		}
	} else if !errors.Is(er, os.ErrNotExist) {
		lease.Close()
		return nil, er
	}
	return lease, nil
}

type ownedJob struct {
	job, process windows.Handle
	pid          uint32
}
type accounting struct {
	User, Kernel, PeriodUser, PeriodKernel int64
	PageFaults, Total, Active, Terminated  uint32
}

func startOwned(argv []string) (*ownedJob, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	owned := &ownedJob{job: job}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		owned.close()
		return nil, err
	}
	app, err := windows.UTF16PtrFromString(argv[0])
	if err != nil {
		owned.close()
		return nil, err
	}
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		quoted[i] = syscall.EscapeArg(arg)
	}
	command, err := windows.UTF16PtrFromString(strings.Join(quoted, " "))
	if err != nil {
		owned.close()
		return nil, err
	}
	startup := windows.StartupInfo{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	info := windows.ProcessInformation{}
	err = windows.CreateProcess(app, command, nil, nil, false, windows.CREATE_SUSPENDED|windows.CREATE_NO_WINDOW, nil, nil, &startup, &info)
	if err != nil {
		owned.close()
		return nil, err
	}
	owned.process = info.Process
	owned.pid = info.ProcessId
	defer windows.CloseHandle(info.Thread)
	if err = windows.AssignProcessToJobObject(job, info.Process); err != nil {
		windows.TerminateProcess(info.Process, 1)
		windows.WaitForSingleObject(info.Process, 5000)
		windows.CloseHandle(info.Process)
		owned.close()
		return nil, err
	}
	if _, err = windows.ResumeThread(info.Thread); err != nil {
		windows.TerminateJobObject(job, 1)
		windows.WaitForSingleObject(info.Process, 5000)
		windows.CloseHandle(info.Process)
		owned.close()
		return nil, err
	}
	return owned, nil
}
func (p *ownedJob) wait() error {
	defer windows.CloseHandle(p.process)
	status, err := windows.WaitForSingleObject(p.process, windows.INFINITE)
	if err != nil {
		return err
	}
	if status != windows.WAIT_OBJECT_0 {
		return errors.New("unconfirmed child wait")
	}
	var code uint32
	if err = windows.GetExitCodeProcess(p.process, &code); err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("synthetic helper exit %d", code)
	}
	return nil
}
func (p *ownedJob) active() (uint32, error) {
	var counters accounting
	err := windows.QueryInformationJobObject(p.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&counters)), uint32(unsafe.Sizeof(counters)), nil)
	return counters.Active, err
}
func (p *ownedJob) terminate() bool {
	if windows.TerminateJobObject(p.job, 1) != nil {
		return false
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		active, err := p.active()
		if err != nil {
			return false
		}
		if active == 0 {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}
func (p *ownedJob) close() {
	if p.job != 0 {
		windows.CloseHandle(p.job)
		p.job = 0
	}
}
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err != windows.ERROR_INVALID_PARAMETER
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if windows.GetExitCodeProcess(handle, &code) != nil {
		return true
	}
	return code == 259 // STILL_ACTIVE
}
