"""One bounded synthetic cycle. Approval and uncertain results stay gated."""
from .engine import DomainError


class Scheduler:
    def __init__(self, engine):
        self.engine = engine

    def step(self):
        handoffs = []
        # Handoff is permitted only after the engine confirmed simulator stop.
        # An empty polling response, stale timestamp or lost connection is NOT
        # evidence that an agent stopped or that its side effects did not run.
        for run in self.engine.snapshot().get("runs", []):
            if run["status"] != "agent_stopped":
                continue
            try:
                result = self.engine.handoff(run["id"],
                    request_id=f"auto-handoff:{run['id']}:{run['epoch']}")
                handoffs.append(result)
            except DomainError as error:
                # Changed plans and competing scheduler transitions remain
                # quarantined by the engine; do not overwrite their states.
                handoffs.append({"run_id": run["id"], "error": error.code})
        return {"handoffs": handoffs, "tick": self.engine.tick()}
