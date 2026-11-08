"""Durable, plan-scoped synthetic execution. No providers or external I/O."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from uuid import uuid4

from .store import Store


class DomainError(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(value):
    if type(value) is not str or not value.strip() or len(value) > 128:
        raise DomainError("invalid_input", "A nonempty identifier is required.", 400)
    return value


def revision_number(value):
    if type(value) is not int or value < 1:
        raise DomainError("invalid_revision", "Revision must be a positive integer.", 400)
    return value


def find(state, collection, item_id):
    identifier(item_id)
    for item in state.get(collection, []):
        if item["id"] == item_id:
            return item
    raise DomainError("not_found", "Requested object was not found.", 404)


def event(state, kind, **data):
    row = {"id": len(state["events"]) + 1, "kind": kind, "created_at": now(), **data}
    state["events"].append(row)


def notification(state, kind):
    # Deliberately excludes names, record IDs, document text and credentials.
    body = {"approval_required": "A decision is required.",
            "attention_required": "An execution needs attention.",
            "run_completed": "An execution has completed."}[kind]
    state["notifications"].append({"id": len(state["notifications"]) + 1,
                                   "kind": kind, "body": body, "created_at": now()})


class Engine:
    def __init__(self, db_path):
        self.store = Store(db_path)
        self.executor_id = str(uuid4())

    def seed_demo(self):
        with self.store.transaction() as (_, state):
            if state:
                return {"seeded": False}
            state.update({"synthetic": True, "schema_version": "many-iris-foundation/1",
                          "projects": [{"id": "demo-project", "title": "架空の個人開発"}],
                          "plans": [], "tasks": [], "documents": [], "runs": [],
                          "approvals": [], "events": [], "notifications": []})
            for plan_id, title in (("demo-plan", "架空の初版準備"), ("other-plan", "許可範囲外の別計画")):
                task_ids = [f"{plan_id}-task-{n}" for n in range(1, 4)]
                state["plans"].append({"id": plan_id, "title": title,
                                       "project_id": "demo-project", "revision": 1,
                                       "task_ids": task_ids})
                for n, task_id in enumerate(task_ids, 1):
                    doc_id = f"{plan_id}-doc-{n}"
                    state["documents"].append({"id": doc_id, "title": f"架空の原文 {n}",
                                               "body": f"説明用の作り物です。架空の作業 {n} の根拠。実情報ではありません。", "revision": 1})
                    state["tasks"].append({"id": task_id, "title": ["状況を整理", "方針を確認", "成果をまとめる"][n - 1],
                                           "plan_id": plan_id, "status": "pending", "document_id": doc_id,
                                           "requires_approval": n == 2, "revision": 1,
                                           "execution_count": 0, "result": None,
                                           "executor_id": None, "owner_epoch": None, "owner_revision": None})
            event(state, "demo_seeded")
            return {"seeded": True}

    def snapshot(self):
        state = self.store.read()
        state["observed_at"] = now()
        state.pop("documents", None)
        return state

    def document(self, document_id):
        return deepcopy(find(self.store.read(), "documents", document_id))

    def notifications(self, after=0):
        if type(after) is not int or after < 0:
            raise DomainError("invalid_input", "Notification cursor must be nonnegative.", 400)
        return {"synthetic": True, "notifications": [n for n in self.store.read().get("notifications", []) if n["id"] > after]}

    def _mutation(self, action, request_id, payload, change):
        identifier(request_id)
        fingerprint = json.dumps([action, payload], sort_keys=True, separators=(",", ":"), allow_nan=False)
        with self.store.transaction() as (conn, state):
            row = conn.execute("SELECT fingerprint,response FROM requests WHERE id=?", (request_id,)).fetchone()
            if row:
                if row[0] != fingerprint:
                    raise DomainError("request_conflict", "Request identifier was already used for different content.")
                return json.loads(row[1])
            result = {"synthetic": True, **change(state)}
            conn.execute("INSERT INTO requests VALUES (?,?,?)", (request_id, fingerprint, json.dumps(result, allow_nan=False)))
            return result

    def start(self, plan_id, revision, request_id):
        identifier(plan_id)
        revision_number(revision)
        def change(state):
            plan = find(state, "plans", plan_id)
            if plan["revision"] != revision:
                raise DomainError("stale_revision", "The plan has changed. Review it again.")
            if any(r["plan_id"] == plan_id for r in state["runs"]):
                raise DomainError("already_started", "This plan already has an execution.")
            run = {"id": str(uuid4()), "plan_id": plan_id, "plan_revision": revision,
                   "status": "active", "agent_id": "synthetic-agent-1", "epoch": 1,
                   "current_task_id": None, "created_at": now()}
            state["runs"].append(run)
            event(state, "run_started", run_id=run["id"], plan_id=plan_id, revision=revision)
            return {"run": deepcopy(run)}
        return self._mutation("start", request_id, [plan_id, revision], change)

    def tick(self, run_id=None):
        if run_id is not None:
            identifier(run_id)
        results = []
        with self.store.transaction() as (_, state):
            runs = [find(state, "runs", run_id)] if run_id else state.get("runs", [])
            for run in runs:
                if run["status"] != "active":
                    continue
                plan = find(state, "plans", run["plan_id"])
                if plan["revision"] != run["plan_revision"]:
                    run["status"] = "revision_changed"
                    event(state, "run_revision_changed", run_id=run["id"])
                    notification(state, "attention_required")
                    continue
                tasks = [find(state, "tasks", i) for i in plan["task_ids"]]
                if any(t["plan_id"] != plan["id"] for t in tasks):
                    raise DomainError("scope_violation", "Task scope does not match the plan.")
                if run["current_task_id"]:
                    task = find(state, "tasks", run["current_task_id"])
                    if task["status"] == "running":
                        if task["revision"] != task.get("owner_revision"):
                            run["status"] = "revision_changed"
                            task["status"] = "revision_changed"
                            event(state, "task_revision_changed", run_id=run["id"], task_id=task["id"])
                            notification(state, "attention_required")
                            continue
                        if task["executor_id"] != self.executor_id:
                            self._unknown(state, run, task)
                            results.append({"run_id": run["id"], "status": "unknown"})
                            continue
                        self._complete(state, run, task, "Synthetic task completed.")
                        results.append({"run_id": run["id"], "task_id": task["id"], "status": "completed"})
                        continue
                task = next((t for t in tasks if t["status"] in ("pending", "ready")), None)
                if task is None:
                    if all(t["status"] == "completed" for t in tasks):
                        run["status"] = "completed"
                        run["current_task_id"] = None
                        event(state, "run_completed", run_id=run["id"])
                        notification(state, "run_completed")
                    continue
                run["current_task_id"] = task["id"]
                if task["requires_approval"] and task["status"] != "ready":
                    approval = {"id": str(uuid4()), "run_id": run["id"], "task_id": task["id"],
                                "revision": plan["revision"], "task_revision": task["revision"],
                                "epoch": run["epoch"], "status": "pending"}
                    state["approvals"].append(approval)
                    task["status"] = "waiting_approval"
                    run["status"] = "waiting_approval"
                    event(state, "approval_required", run_id=run["id"], approval_id=approval["id"])
                    notification(state, "approval_required")
                    results.append({"run_id": run["id"], "status": "waiting_approval"})
                else:
                    task.update(status="running", executor_id=self.executor_id,
                                owner_epoch=run["epoch"], owner_revision=task["revision"])
                    task["execution_count"] += 1
                    event(state, "task_started", run_id=run["id"], task_id=task["id"], epoch=run["epoch"])
                    results.append({"run_id": run["id"], "task_id": task["id"], "status": "running"})
        return {"synthetic": True, "results": results}

    def _complete(self, state, run, task, result):
        task.update(status="completed", result=result, executor_id=None)
        run["current_task_id"] = None
        event(state, "task_completed", run_id=run["id"], task_id=task["id"], epoch=run["epoch"])

    def _unknown(self, state, run, task):
        run["status"] = "unknown"
        task["status"] = "unknown"
        event(state, "execution_unknown", run_id=run["id"], task_id=task["id"])
        notification(state, "attention_required")

    def decide(self, approval_id, decision, revision, request_id):
        identifier(approval_id)
        revision_number(revision)
        if decision not in ("approve", "reject"):
            raise DomainError("invalid_decision", "Decision must be approve or reject.", 400)
        def change(state):
            approval = find(state, "approvals", approval_id)
            run = find(state, "runs", approval["run_id"])
            task = find(state, "tasks", approval["task_id"])
            plan = find(state, "plans", run["plan_id"])
            if approval["status"] != "pending":
                raise DomainError("approval_closed", "This decision is already closed.")
            if (revision != approval["revision"] or revision != plan["revision"]
                    or revision != run["plan_revision"] or approval["task_revision"] != task["revision"]
                    or approval["epoch"] != run["epoch"]):
                raise DomainError("stale_revision", "The approved content or owner has changed.")
            if run["status"] not in ("waiting_approval", "paused"):
                raise DomainError("invalid_state", "Execution cannot accept this decision now.")
            approval["status"] = "approved" if decision == "approve" else "rejected"
            task["status"] = "ready" if decision == "approve" else "rejected"
            if decision == "reject":
                run["status"] = "rejected"
            elif run["status"] != "paused":
                run["status"] = "active"
            event(state, "approval_decided", approval_id=approval_id, decision=decision, revision=revision)
            return {"approval": deepcopy(approval), "run": deepcopy(run)}
        return self._mutation("decide", request_id, [approval_id, decision, revision], change)

    def _run_action(self, action, run_id, request_id):
        identifier(run_id)
        def change(state):
            run = find(state, "runs", run_id)
            status = run["status"]
            if action == "pause":
                if status not in ("active", "waiting_approval"):
                    raise DomainError("invalid_state", "Only a running or waiting execution can pause.")
                run["status"] = "paused"
            elif action == "resume":
                if status != "paused":
                    raise DomainError("invalid_state", "Only a paused execution can resume.")
                run["status"] = "waiting_approval" if any(a["run_id"] == run_id and a["status"] == "pending" for a in state["approvals"]) else "active"
            elif action == "stop_agent":
                if status not in ("active", "waiting_approval", "paused"):
                    raise DomainError("invalid_state", "An uncertain execution cannot be confirmed stopped automatically.")
                run["status"] = "agent_stopped"
                # Synthetic executor has no external process. This confirms the demo stop only.
                run["epoch"] += 1
                if run["current_task_id"]:
                    task = find(state, "tasks", run["current_task_id"])
                    if task["status"] == "running":
                        task["status"] = "interrupted"
            elif action == "handoff":
                if status != "agent_stopped":
                    raise DomainError("stop_not_confirmed", "Confirm the previous synthetic agent is stopped first.")
                plan = find(state, "plans", run["plan_id"])
                if run["plan_revision"] != plan["revision"]:
                    raise DomainError("stale_revision", "Plan scope changed before handoff.")
                run["agent_id"] = f"synthetic-agent-{run['epoch']}"
                for approval in state["approvals"]:
                    if approval["run_id"] == run_id and approval["status"] == "pending":
                        approval["status"] = "superseded"
                if run["current_task_id"]:
                    task = find(state, "tasks", run["current_task_id"])
                    if task["status"] in ("interrupted", "waiting_approval", "ready"):
                        task.update(status="pending", executor_id=None)
                run["current_task_id"] = None
                run["status"] = "active"
            event(state, action, run_id=run_id, epoch=run["epoch"])
            return {"run": deepcopy(run)}
        return self._mutation(action, request_id, [run_id], change)

    def pause(self, run_id, request_id):
        return self._run_action("pause", run_id, request_id)

    def resume(self, run_id, request_id):
        return self._run_action("resume", run_id, request_id)

    def stop_agent(self, run_id, request_id):
        return self._run_action("stop_agent", run_id, request_id)

    def handoff(self, run_id, request_id):
        return self._run_action("handoff", run_id, request_id)

    def mark_unknown(self, run_id, request_id):
        def change(state):
            run = find(state, "runs", run_id)
            if run["status"] != "active" or not run["current_task_id"]:
                raise DomainError("invalid_state", "No active task has an uncertain outcome.")
            task = find(state, "tasks", run["current_task_id"])
            if task["status"] != "running":
                raise DomainError("invalid_state", "No active task has an uncertain outcome.")
            self._unknown(state, run, task)
            return {"run": deepcopy(run)}
        return self._mutation("mark_unknown", request_id, [run_id], change)

    def submit_result(self, run_id, task_id, epoch, result, request_id):
        revision_number(epoch)
        if type(result) is not str or len(result) > 4096:
            raise DomainError("invalid_result", "Result must be bounded text.", 400)
        def change(state):
            run = find(state, "runs", run_id)
            task = find(state, "tasks", task_id)
            plan = find(state, "plans", run["plan_id"])
            if (plan["revision"] != run["plan_revision"]
                    or task["revision"] != task.get("owner_revision")):
                raise DomainError("stale_revision", "The execution instruction has changed.")
            if (run["epoch"] != epoch or task["owner_epoch"] != epoch
                    or run["current_task_id"] != task_id or task["plan_id"] != run["plan_id"]):
                raise DomainError("stale_owner", "Result does not belong to the current owner.")
            if run["status"] != "active" or task["status"] != "running":
                raise DomainError("invalid_state", "Execution cannot accept a result now.")
            self._complete(state, run, task, result)
            return {"run": deepcopy(run), "task": deepcopy(task)}
        return self._mutation("submit_result", request_id, [run_id, task_id, epoch, result], change)

    def revise_plan(self, plan_id, request_id):
        """Synthetic test/control hook: invalidate existing instruction approval."""
        def change(state):
            plan = find(state, "plans", plan_id)
            plan["revision"] += 1
            event(state, "plan_revised", plan_id=plan_id, revision=plan["revision"])
            return {"plan": deepcopy(plan)}
        return self._mutation("revise_plan", request_id, [plan_id], change)
