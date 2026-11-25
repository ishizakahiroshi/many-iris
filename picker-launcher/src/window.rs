#![cfg(windows)]

use crate::runner::PickerRunner;
use std::{
    ffi::c_void,
    io,
    ptr::{null, null_mut},
    sync::{
        Arc,
        atomic::{AtomicIsize, Ordering},
    },
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, POINT,
        RECT, WPARAM,
    },
    Graphics::{
        Dwm::{
            DWMWA_BORDER_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE,
            DWMWCP_ROUND, DwmSetWindowAttribute,
        },
        Gdi::{
            BeginPaint, COLOR_BTNFACE, COLOR_BTNTEXT, COLOR_HIGHLIGHT, COLOR_HIGHLIGHTTEXT,
            COLOR_WINDOW, COLOR_WINDOWFRAME, COLOR_WINDOWTEXT, CreateFontIndirectW, CreatePen,
            CreateRoundRectRgn, CreateSolidBrush, DT_CENTER, DT_END_ELLIPSIS, DT_NOPREFIX,
            DT_SINGLELINE, DT_VCENTER, DeleteObject, DrawFocusRect, DrawTextW, EndPaint,
            FW_SEMIBOLD, FillRect, GetSysColor, GetSysColorBrush, HBRUSH, HDC, HFONT, HPEN,
            InvalidateRect, OPAQUE, PAINTSTRUCT, PS_SOLID, RoundRect, ScreenToClient, SelectObject,
            SetBkColor, SetBkMode, SetTextColor, SetWindowRgn, TRANSPARENT,
        },
    },
    System::{LibraryLoader::GetModuleHandleW, Threading::CreateMutexW},
    UI::{
        Controls::{DRAWITEMSTRUCT, ODS_FOCUS, ODS_HOTLIGHT, ODS_NOFOCUSRECT, ODS_SELECTED},
        HiDpi::GetDpiForSystem,
        Shell::ShellExecuteW,
        WindowsAndMessaging::*,
    },
};

const WINDOW_CLASS: &str = "ManyIrisPickerPresenceWindow";
const MUTEX_NAME: &str = "Local\\ManyIrisPickerPresenceLauncher";
const APP_TITLE: &str = "many-iris-picker";

const PRESENCE_STATE: u32 = WM_APP + 1;
const PRESENCE_WIDTH: i32 = 288;
const PRESENCE_HEIGHT: i32 = 136;
const PRESENCE_EDGE: i32 = 16;

const CMD_OPEN_BOARD: u32 = 1;
const CMD_EXIT: u32 = 2;
const CMD_MINIMIZE: u32 = 7;

const SS_LEFT: u32 = 0;
const SS_NOPREFIX: u32 = 128;
const SS_CENTERIMAGE: u32 = 512;
const SS_ICON: u32 = 3;
const SS_REALSIZECONTROL: u32 = 64;
const HIGH_CONTRAST_ON: u32 = 1;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetUserDefaultUILanguage() -> u16;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

pub fn show_error(message: &str) {
    let text = wide(message);
    let title = wide(APP_TITLE);
    unsafe {
        MessageBoxW(
            null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TASKMODAL,
        );
    }
}

struct PresenceCopy {
    running: &'static str,
    paused: &'static str,
    stopped: &'static str,
    open: &'static str,
    stop: &'static str,
    minimize: &'static str,
}

fn presence_copy(langid: u16) -> PresenceCopy {
    match langid & 0x3ff {
        0x09 => PresenceCopy {
            running: "Running",
            paused: "Paused (STOP)",
            stopped: "Stopped",
            open: "Open board",
            stop: "Exit",
            minimize: "Minimize",
        },
        _ => PresenceCopy {
            running: "動いています",
            paused: "一時停止中（STOP）",
            stopped: "止まっています",
            open: "看板を開く",
            stop: "終了",
            minimize: "しまう",
        },
    }
}

struct PresencePalette {
    background: u32,
    title: u32,
    status: u32,
    primary_fill: u32,
    primary_fill_pressed: u32,
    primary_text: u32,
    secondary_fill: u32,
    secondary_fill_pressed: u32,
    secondary_text: u32,
    secondary_border: u32,
    quiet_fill_pressed: u32,
    quiet_mark: u32,
    border: u32,
}

struct SystemColors {
    window: u32,
    text: u32,
    highlight: u32,
    highlight_text: u32,
    face: u32,
    button_text: u32,
    frame: u32,
}

struct CardRect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

struct CardLayout {
    mark: CardRect,
    title: CardRect,
    minimize: CardRect,
    status: CardRect,
    open: CardRect,
    exit: CardRect,
}

struct PresenceWindow {
    runner: Arc<PickerRunner>,
    board_web_url: String,
    status: HWND,
    text: PresenceCopy,
    palette: PresencePalette,
    background: HBRUSH,
    border: HPEN,
    title_font: HFONT,
    body_font: HFONT,
    corner: i32,
    paint_border: bool,
}

fn presence_palette(dark: bool) -> PresencePalette {
    if dark {
        PresencePalette {
            background: 0x0024_2424,
            title: 0x00F3_F3F3,
            status: 0x00B4_B4B4,
            primary_fill: 0x00F3_F3F3,
            primary_fill_pressed: 0x00D6_D6D6,
            primary_text: 0x001A_1A1A,
            secondary_fill: 0x0024_2424,
            secondary_fill_pressed: 0x0033_3333,
            secondary_text: 0x00F3_F3F3,
            secondary_border: 0x005A_5A5A,
            quiet_fill_pressed: 0x003A_3A3A,
            quiet_mark: 0x00F3_F3F3,
            border: 0x003F_3F3F,
        }
    } else {
        PresencePalette {
            background: 0x00F7_F7F7,
            title: 0x001A_1A1A,
            status: 0x005C_5C5C,
            primary_fill: 0x001A_1A1A,
            primary_fill_pressed: 0x0033_3333,
            primary_text: 0x00FF_FFFF,
            secondary_fill: 0x00FF_FFFF,
            secondary_fill_pressed: 0x00EF_EFEF,
            secondary_text: 0x001A_1A1A,
            secondary_border: 0x00D0_D0D0,
            quiet_fill_pressed: 0x00E6_E6E6,
            quiet_mark: 0x001A_1A1A,
            border: 0x00E0_E0E0,
        }
    }
}

fn color_is_dark(color: u32) -> bool {
    let red = color & 0xff;
    let green = (color >> 8) & 0xff;
    let blue = (color >> 16) & 0xff;
    red * 30 + green * 59 + blue * 11 < 12_800
}

fn personalize_light_theme() -> Option<u32> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    let subkey = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let name = wide("AppsUseLightTheme");
    let mut data = 0u32;
    let mut size = std::mem::size_of_val(&data) as u32;
    let error = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            null_mut(),
            &mut data as *mut u32 as *mut c_void,
            &mut size,
        )
    };
    (error == 0).then_some(data)
}

#[repr(C)]
struct HighContrastMode {
    size: u32,
    flags: u32,
    scheme: *mut u16,
}

fn contrast_colors() -> Option<SystemColors> {
    let mut mode = HighContrastMode {
        size: std::mem::size_of::<HighContrastMode>() as u32,
        flags: 0,
        scheme: null_mut(),
    };
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            mode.size,
            &mut mode as *mut HighContrastMode as *mut c_void,
            0,
        )
    };
    if ok == 0 || mode.flags & HIGH_CONTRAST_ON == 0 {
        return None;
    }
    Some(SystemColors {
        window: unsafe { GetSysColor(COLOR_WINDOW) },
        text: unsafe { GetSysColor(COLOR_WINDOWTEXT) },
        highlight: unsafe { GetSysColor(COLOR_HIGHLIGHT) },
        highlight_text: unsafe { GetSysColor(COLOR_HIGHLIGHTTEXT) },
        face: unsafe { GetSysColor(COLOR_BTNFACE) },
        button_text: unsafe { GetSysColor(COLOR_BTNTEXT) },
        frame: unsafe { GetSysColor(COLOR_WINDOWFRAME) },
    })
}

fn current_palette() -> PresencePalette {
    if let Some(colors) = contrast_colors() {
        return PresencePalette {
            background: colors.window,
            title: colors.text,
            status: colors.text,
            primary_fill: colors.highlight,
            primary_fill_pressed: colors.highlight,
            primary_text: colors.highlight_text,
            secondary_fill: colors.face,
            secondary_fill_pressed: colors.face,
            secondary_text: colors.button_text,
            secondary_border: colors.frame,
            quiet_fill_pressed: colors.frame,
            quiet_mark: colors.button_text,
            border: colors.frame,
        };
    }
    presence_palette(personalize_light_theme() == Some(0))
}

fn presence_dpi() -> i32 {
    i32::try_from(unsafe { GetDpiForSystem() })
        .unwrap_or(96)
        .max(96)
}

fn presence_scaled(value: i32, dpi: i32) -> i32 {
    value * dpi / 96
}

fn card_layout(width: i32, height: i32, dpi: i32) -> CardLayout {
    let margin = presence_scaled(16, dpi);
    let gap = presence_scaled(8, dpi);
    let min_size = presence_scaled(28, dpi);
    let inner = (width - margin * 2).max(0);
    let open_w = presence_scaled(164, dpi).min((inner - gap).max(0));
    let exit_w = presence_scaled(88, dpi).min((inner - gap - open_w).max(0));
    let button_h = presence_scaled(32, dpi);
    let mark_size = presence_scaled(20, dpi).min(min_size);
    CardLayout {
        mark: CardRect {
            x: margin,
            y: margin + (min_size - mark_size) / 2,
            w: mark_size,
            h: mark_size,
        },
        title: CardRect {
            x: margin + mark_size + gap,
            y: margin,
            w: (inner - mark_size - gap * 2 - min_size).max(0),
            h: min_size,
        },
        minimize: CardRect {
            x: width - margin - min_size,
            y: margin,
            w: min_size,
            h: min_size,
        },
        status: CardRect {
            x: margin,
            y: margin + min_size + presence_scaled(4, dpi),
            w: inner,
            h: presence_scaled(22, dpi),
        },
        open: CardRect {
            x: margin,
            y: (height - margin - button_h).max(margin),
            w: open_w,
            h: button_h,
        },
        exit: CardRect {
            x: margin + open_w + gap,
            y: (height - margin - button_h).max(margin),
            w: exit_w,
            h: button_h,
        },
    }
}

fn presence_position() -> (i32, i32) {
    let mut area = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut area as *mut RECT as *mut c_void, 0)
    };
    let dpi = presence_dpi();
    let edge = presence_scaled(PRESENCE_EDGE, dpi);
    let width = presence_scaled(PRESENCE_WIDTH, dpi);
    let height = presence_scaled(PRESENCE_HEIGHT, dpi);
    if ok != 0 {
        // Place slightly above the bottom-right corner so it does not cover many-ai-cli's card if both are open.
        (area.right - edge - width, area.bottom - edge - height)
    } else {
        (100, 100)
    }
}

fn message_fonts(dpi: i32) -> (HFONT, HFONT) {
    unsafe {
        let mut metrics: NONCLIENTMETRICSW = std::mem::zeroed();
        metrics.cbSize = std::mem::size_of::<NONCLIENTMETRICSW>() as u32;
        if SystemParametersInfoW(
            SPI_GETNONCLIENTMETRICS,
            metrics.cbSize,
            &mut metrics as *mut NONCLIENTMETRICSW as *mut c_void,
            0,
        ) == 0
        {
            return (null_mut(), null_mut());
        }
        let body = CreateFontIndirectW(&metrics.lfMessageFont);
        let mut title = metrics.lfMessageFont;
        title.lfWeight = FW_SEMIBOLD as i32;
        if title.lfHeight < 0 {
            title.lfHeight -= presence_scaled(2, dpi);
        } else if title.lfHeight > 0 {
            title.lfHeight += presence_scaled(2, dpi);
        }
        (CreateFontIndirectW(&title), body)
    }
}

fn load_owned_icon(instance: HINSTANCE, width: i32, height: i32) -> HICON {
    unsafe {
        LoadImageW(
            instance,
            std::ptr::without_provenance::<u16>(1),
            IMAGE_ICON,
            width,
            height,
            LR_DEFAULTCOLOR,
        )
    }
}

fn load_presence_icons(instance: HINSTANCE) -> (Vec<HICON>, HICON, HICON) {
    let big = load_owned_icon(instance, unsafe { GetSystemMetrics(SM_CXICON) }, unsafe {
        GetSystemMetrics(SM_CYICON)
    });
    let small = load_owned_icon(instance, unsafe { GetSystemMetrics(SM_CXSMICON) }, unsafe {
        GetSystemMetrics(SM_CYSMICON)
    });
    if big.is_null() && small.is_null() {
        let shared = unsafe { LoadIconW(null_mut(), IDI_APPLICATION) };
        return (Vec::new(), shared, shared);
    }
    let mut owned = Vec::new();
    if !big.is_null() {
        owned.push(big);
    }
    if !small.is_null() {
        owned.push(small);
    }
    let big = if big.is_null() { small } else { big };
    let small = if small.is_null() { big } else { small };
    (owned, big, small)
}

fn open_browser(url: &str) {
    let verb = wide("open");
    let target = wide(url);
    unsafe {
        ShellExecuteW(
            null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        );
    }
}

fn lock_card_size(parameter: LPARAM) {
    let info = std::ptr::without_provenance_mut::<MINMAXINFO>(parameter as usize);
    if info.is_null() {
        return;
    }
    let dpi = presence_dpi();
    let width = presence_scaled(PRESENCE_WIDTH, dpi);
    let height = presence_scaled(PRESENCE_HEIGHT, dpi);
    unsafe {
        (*info).ptMinTrackSize.x = width;
        (*info).ptMinTrackSize.y = height;
        (*info).ptMaxTrackSize.x = width;
        (*info).ptMaxTrackSize.y = height;
    }
}

fn presence_hit(window: HWND, parameter: LPARAM) -> LRESULT {
    let packed = parameter as u32;
    let mut point = POINT {
        x: packed as i16 as i32,
        y: (packed >> 16) as i16 as i32,
    };
    unsafe {
        if ScreenToClient(window, &mut point) == 0 {
            return HTCLIENT as LRESULT;
        }
        let child = ChildWindowFromPoint(window, point);
        let id = GetDlgCtrlID(child);
        if !child.is_null()
            && child != window
            && (id == CMD_OPEN_BOARD as i32
                || id == CMD_EXIT as i32
                || id == CMD_MINIMIZE as i32)
        {
            HTCLIENT as LRESULT
        } else {
            HTCAPTION as LRESULT
        }
    }
}

fn fill_round(dc: HDC, rect: RECT, fill: u32, border: u32, radius: i32) {
    unsafe {
        let brush = CreateSolidBrush(fill);
        let pen = CreatePen(PS_SOLID, 1, border);
        if brush.is_null() || pen.is_null() {
            if !brush.is_null() {
                DeleteObject(brush);
            }
            if !pen.is_null() {
                DeleteObject(pen);
            }
            return;
        }
        let old_brush = SelectObject(dc, brush);
        let old_pen = SelectObject(dc, pen);
        RoundRect(
            dc,
            rect.left,
            rect.top,
            rect.right - 1,
            rect.bottom - 1,
            radius,
            radius,
        );
        if !old_brush.is_null() {
            SelectObject(dc, old_brush);
        }
        if !old_pen.is_null() {
            SelectObject(dc, old_pen);
        }
        DeleteObject(brush);
        DeleteObject(pen);
    }
}

fn draw_button_text(dc: HDC, control: HWND, font: HFONT, color: u32, rect: RECT) {
    unsafe {
        let mut buffer = [0u16; 64];
        let count = GetWindowTextW(control, buffer.as_mut_ptr(), buffer.len() as i32);
        if count <= 0 {
            return;
        }
        let previous = if font.is_null() {
            null_mut()
        } else {
            SelectObject(dc, font)
        };
        SetBkMode(dc, TRANSPARENT as i32);
        SetTextColor(dc, color);
        let mut text_rect = rect;
        DrawTextW(
            dc,
            buffer.as_ptr(),
            count,
            &mut text_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        );
        if !previous.is_null() {
            SelectObject(dc, previous);
        }
    }
}

fn draw_minus(dc: HDC, rect: RECT, color: u32) {
    unsafe {
        let brush = CreateSolidBrush(color);
        if brush.is_null() {
            return;
        }
        let center_x = (rect.left + rect.right) / 2;
        let center_y = (rect.top + rect.bottom) / 2;
        let half = ((rect.right - rect.left) / 5).max(4);
        let bar = RECT {
            left: center_x - half,
            top: center_y - 1,
            right: center_x + half,
            bottom: center_y + 1,
        };
        FillRect(dc, &bar, brush);
        DeleteObject(brush);
    }
}

fn draw_card_item(presence: *const PresenceWindow, parameter: LPARAM) {
    if presence.is_null() {
        return;
    }
    let data = unsafe { &*presence };
    let item = unsafe { &*std::ptr::without_provenance::<DRAWITEMSTRUCT>(parameter as usize) };
    let engaged = item.itemState & (ODS_SELECTED | ODS_HOTLIGHT) != 0;
    let focused = item.itemState & ODS_FOCUS != 0 && item.itemState & ODS_NOFOCUSRECT == 0;
    if !data.background.is_null() {
        unsafe {
            FillRect(item.hDC, &item.rcItem, data.background);
        }
    }
    match item.CtlID {
        CMD_OPEN_BOARD => {
            let fill = if engaged {
                data.palette.primary_fill_pressed
            } else {
                data.palette.primary_fill
            };
            fill_round(item.hDC, item.rcItem, fill, fill, data.corner);
            draw_button_text(
                item.hDC,
                item.hwndItem,
                data.body_font,
                data.palette.primary_text,
                item.rcItem,
            );
        }
        CMD_EXIT => {
            let fill = if engaged {
                data.palette.secondary_fill_pressed
            } else {
                data.palette.secondary_fill
            };
            fill_round(
                item.hDC,
                item.rcItem,
                fill,
                data.palette.secondary_border,
                data.corner,
            );
            draw_button_text(
                item.hDC,
                item.hwndItem,
                data.body_font,
                data.palette.secondary_text,
                item.rcItem,
            );
        }
        CMD_MINIMIZE => {
            let fill = if engaged {
                data.palette.quiet_fill_pressed
            } else {
                data.palette.background
            };
            fill_round(item.hDC, item.rcItem, fill, fill, data.corner);
            draw_minus(item.hDC, item.rcItem, data.palette.quiet_mark);
        }
        _ => {}
    }
    if focused {
        let focus = RECT {
            left: item.rcItem.left + 3,
            top: item.rcItem.top + 3,
            right: item.rcItem.right - 3,
            bottom: item.rcItem.bottom - 3,
        };
        if focus.right > focus.left && focus.bottom > focus.top {
            unsafe {
                DrawFocusRect(item.hDC, &focus);
            }
        }
    }
}

fn polish_card_frame(window: HWND, border: u32, dark: bool, diameter: i32) -> bool {
    let corner = DWMWCP_ROUND;
    let rounded = unsafe {
        DwmSetWindowAttribute(
            window,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &corner as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        )
    };
    let mode = i32::from(dark);
    unsafe {
        DwmSetWindowAttribute(
            window,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            &mode as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
        DwmSetWindowAttribute(
            window,
            DWMWA_BORDER_COLOR as u32,
            &border as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
    if rounded >= 0 {
        return false;
    }
    unsafe {
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(window, &mut rect) == 0 {
            return true;
        }
        let region = CreateRoundRectRgn(
            0,
            0,
            rect.right - rect.left + 1,
            rect.bottom - rect.top + 1,
            diameter,
            diameter,
        );
        if region.is_null() {
            return true;
        }
        if SetWindowRgn(window, region, 1) == 0 {
            DeleteObject(region);
        }
    }
    true
}

fn release_card_chrome(state: &PresenceWindow) {
    unsafe {
        if !state.background.is_null() {
            DeleteObject(state.background);
        }
        if !state.border.is_null() {
            DeleteObject(state.border);
        }
        if !state.title_font.is_null() {
            DeleteObject(state.title_font);
        }
        if !state.body_font.is_null() {
            DeleteObject(state.body_font);
        }
    }
}

unsafe extern "system" fn presence_procedure(
    window: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
) -> LRESULT {
    unsafe {
        let pointer = GetWindowLongPtrW(window, GWLP_USERDATA) as *const PresenceWindow;
        match message {
            WM_COMMAND => {
                if !pointer.is_null() {
                    let data = &*pointer;
                    match w as u32 & 0xffff {
                        CMD_OPEN_BOARD => open_browser(&data.board_web_url),
                        CMD_EXIT => {
                            data.runner.stop();
                            DestroyWindow(window);
                        }
                        CMD_MINIMIZE => {
                            ShowWindow(window, SW_MINIMIZE);
                        }
                        _ => {}
                    }
                }
                0
            }
            WM_CLOSE => {
                if !pointer.is_null() {
                    (*pointer).runner.stop();
                }
                DestroyWindow(window);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            PRESENCE_STATE => {
                if !pointer.is_null() {
                    let data = &*pointer;
                    let label = if w == 0 {
                        data.text.stopped
                    } else if data.runner.is_paused() {
                        data.text.paused
                    } else {
                        data.text.running
                    };
                    let label = wide(label);
                    SetWindowTextW(data.status, label.as_ptr());
                }
                0
            }
            WM_NCCALCSIZE => {
                if w == 0 {
                    DefWindowProcW(window, message, w, l)
                } else {
                    0
                }
            }
            WM_NCHITTEST => presence_hit(window, l),
            WM_GETMINMAXINFO => {
                lock_card_size(l);
                0
            }
            WM_ERASEBKGND => {
                if !pointer.is_null() && !(*pointer).background.is_null() {
                    let mut client = RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    };
                    GetClientRect(window, &mut client);
                    FillRect(
                        std::ptr::without_provenance_mut(w),
                        &client,
                        (*pointer).background,
                    );
                    1
                } else {
                    DefWindowProcW(window, message, w, l)
                }
            }
            WM_PAINT => {
                let mut paint: PAINTSTRUCT = std::mem::zeroed();
                let dc = BeginPaint(window, &mut paint);
                if !pointer.is_null() && !dc.is_null() {
                    let data = &*pointer;
                    if data.paint_border && !data.border.is_null() && !data.background.is_null() {
                        let mut client = RECT {
                            left: 0,
                            top: 0,
                            right: 0,
                            bottom: 0,
                        };
                        GetClientRect(window, &mut client);
                        let old_pen = SelectObject(dc, data.border);
                        let old_brush = SelectObject(dc, data.background);
                        RoundRect(
                            dc,
                            0,
                            0,
                            client.right - 1,
                            client.bottom - 1,
                            data.corner * 2,
                            data.corner * 2,
                        );
                        if !old_pen.is_null() {
                            SelectObject(dc, old_pen);
                        }
                        if !old_brush.is_null() {
                            SelectObject(dc, old_brush);
                        }
                    }
                }
                EndPaint(window, &paint);
                0
            }
            WM_CTLCOLORSTATIC => {
                if pointer.is_null() || (*pointer).background.is_null() {
                    return DefWindowProcW(window, message, w, l);
                }
                let data = &*pointer;
                let target = std::ptr::without_provenance_mut::<c_void>(l as usize);
                let color = if target == data.status {
                    data.palette.status
                } else {
                    data.palette.title
                };
                let target_dc = std::ptr::without_provenance_mut(w);
                SetBkMode(target_dc, OPAQUE as i32);
                SetBkColor(target_dc, data.palette.background);
                SetTextColor(target_dc, color);
                data.background as LRESULT
            }
            WM_DRAWITEM => {
                draw_card_item(pointer, l);
                1
            }
            _ => DefWindowProcW(window, message, w, l),
        }
    }
}

pub fn run(runner: Arc<PickerRunner>, board_web_url: String) -> io::Result<()> {
    unsafe {
        let mutex = CreateMutexW(null(), 0, wide(MUTEX_NAME).as_ptr());
        if mutex.is_null() {
            return Err(io::Error::last_os_error());
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let class = wide(WINDOW_CLASS);
            let existing = FindWindowW(class.as_ptr(), null());
            if !existing.is_null() {
                ShowWindow(existing, SW_RESTORE);
                SetForegroundWindow(existing);
            }
            CloseHandle(mutex);
            return Ok(());
        }

        let result = run_window_loop(runner, board_web_url);
        CloseHandle(mutex);
        result
    }
}

unsafe fn run_window_loop(runner: Arc<PickerRunner>, board_web_url: String) -> io::Result<()> {
    unsafe {
        let instance = GetModuleHandleW(null());
        let class_name = wide(WINDOW_CLASS);
        let class = WNDCLASSW {
            lpfnWndProc: Some(presence_procedure),
            hInstance: instance,
            lpszClassName: class_name.as_ptr(),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            ..std::mem::zeroed()
        };
        if RegisterClassW(&class) == 0 {
            return Err(io::Error::last_os_error());
        }

        let (x, y) = presence_position();
        let dpi = presence_dpi();
        let scaled = |value: i32| presence_scaled(value, dpi);
        let window = CreateWindowExW(
            WS_EX_APPWINDOW,
            class_name.as_ptr(),
            wide(APP_TITLE).as_ptr(),
            WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_CLIPCHILDREN,
            x,
            y,
            scaled(PRESENCE_WIDTH),
            scaled(PRESENCE_HEIGHT),
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        if window.is_null() {
            let err = io::Error::last_os_error();
            UnregisterClassW(class_name.as_ptr(), instance);
            return Err(err);
        }

        let text = presence_copy(GetUserDefaultUILanguage());
        let palette = current_palette();
        let (title_font, body_font) = message_fonts(dpi);
        let background = CreateSolidBrush(palette.background);
        let border = CreatePen(PS_SOLID, 1, palette.border);
        let corner = scaled(8);

        let mut client = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        GetClientRect(window, &mut client);
        let layout = card_layout(client.right - client.left, client.bottom - client.top, dpi);
        let label_style = WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX | SS_CENTERIMAGE;
        let button_style = WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW as u32;

        let logo = CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            null(),
            WS_CHILD | WS_VISIBLE | SS_ICON | SS_CENTERIMAGE | SS_REALSIZECONTROL,
            layout.mark.x,
            layout.mark.y,
            layout.mark.w,
            layout.mark.h,
            window,
            std::ptr::without_provenance_mut(103),
            instance,
            null(),
        );
        let title = CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(APP_TITLE).as_ptr(),
            label_style,
            layout.title.x,
            layout.title.y,
            layout.title.w,
            layout.title.h,
            window,
            std::ptr::without_provenance_mut(102),
            instance,
            null(),
        );
        let initial_status = if runner.is_running() {
            if runner.is_paused() {
                text.paused
            } else {
                text.running
            }
        } else {
            text.stopped
        };
        let status = CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide(initial_status).as_ptr(),
            label_style,
            layout.status.x,
            layout.status.y,
            layout.status.w,
            layout.status.h,
            window,
            std::ptr::without_provenance_mut(100),
            instance,
            null(),
        );
        let _open = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide(text.open).as_ptr(),
            button_style,
            layout.open.x,
            layout.open.y,
            layout.open.w,
            layout.open.h,
            window,
            std::ptr::without_provenance_mut(CMD_OPEN_BOARD as usize),
            instance,
            null(),
        );
        let _stop = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide(text.stop).as_ptr(),
            button_style,
            layout.exit.x,
            layout.exit.y,
            layout.exit.w,
            layout.exit.h,
            window,
            std::ptr::without_provenance_mut(CMD_EXIT as usize),
            instance,
            null(),
        );
        let _minimize = CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide(text.minimize).as_ptr(),
            button_style,
            layout.minimize.x,
            layout.minimize.y,
            layout.minimize.w,
            layout.minimize.h,
            window,
            std::ptr::without_provenance_mut(CMD_MINIMIZE as usize),
            instance,
            null(),
        );

        if !title_font.is_null() {
            SendMessageW(title, WM_SETFONT, title_font as usize, 1);
        }
        if !body_font.is_null() {
            SendMessageW(status, WM_SETFONT, body_font as usize, 1);
        }

        let (mut owned_icons, big, small) = load_presence_icons(instance);
        if !big.is_null() {
            SendMessageW(window, WM_SETICON, ICON_BIG as usize, big as isize);
        }
        if !small.is_null() {
            SendMessageW(window, WM_SETICON, ICON_SMALL as usize, small as isize);
        }
        let mut mark_icon = load_owned_icon(instance, layout.mark.w, layout.mark.h);
        if !mark_icon.is_null() {
            owned_icons.push(mark_icon);
        } else {
            mark_icon = if !small.is_null() { small } else { big };
        }
        if !mark_icon.is_null() {
            SendMessageW(logo, STM_SETICON, mark_icon as usize, 0);
        }

        let paint_border = polish_card_frame(
            window,
            palette.border,
            color_is_dark(palette.background),
            scaled(16),
        );
        let state = Box::new(PresenceWindow {
            runner: runner.clone(),
            board_web_url,
            status,
            text,
            palette,
            background,
            border,
            title_font,
            body_font,
            corner,
            paint_border,
        });
        SetWindowLongPtrW(
            window,
            GWLP_USERDATA,
            &*state as *const PresenceWindow as isize,
        );
        InvalidateRect(window, null(), 1);
        ShowWindow(window, SW_SHOWNOACTIVATE);

        let hwnd_shared = Arc::new(AtomicIsize::new(window as isize));
        let hwnd_cb = hwnd_shared.clone();
        if let Err(err) = runner.start(move |is_running| {
            let raw = hwnd_cb.load(Ordering::Acquire);
            if raw != 0 {
                PostMessageW(
                    std::ptr::without_provenance_mut(raw as usize),
                    PRESENCE_STATE,
                    usize::from(is_running),
                    0,
                );
            }
        }) {
            show_error(&format!("picker の起動に失敗しました:\n{err}"));
        }

        let mut msg: MSG = std::mem::zeroed();
        let loop_result = loop {
            let receipt = GetMessageW(&mut msg, null_mut(), 0, 0);
            if receipt < 0 {
                break Err(io::Error::last_os_error());
            }
            if receipt == 0 {
                break Ok(());
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        };

        hwnd_shared.store(0, Ordering::Release);
        runner.stop();
        if IsWindow(window) != 0 {
            DestroyWindow(window);
        }
        release_card_chrome(&state);
        for icon in owned_icons {
            DestroyIcon(icon);
        }
        drop(state);
        UnregisterClassW(class_name.as_ptr(), instance);
        loop_result
    }
}
