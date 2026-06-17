from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable


class JobState(str, Enum):
    pending = "pending"
    running = "running"
    done = "done"
    error = "error"


@dataclass
class Job:
    id: str
    kind: str
    state: JobState = JobState.pending
    progress: float = 0.0
    message: str = ""
    result: Any = None
    error: str | None = None
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    cancel_requested: bool = False

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "state": self.state.value,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
        }


ProgressFn = Callable[[float, str], None]


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self) -> None:
        self._loop = asyncio.get_running_loop()

    def create(self, kind: str) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind)
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        """Request cancellation of a job. Returns True if job was found."""
        job = self._jobs.get(job_id)
        if job is None:
            return False
        job.cancel_requested = True
        return True

    def _emit(self, job: Job) -> None:
        event = job.snapshot()
        if self._loop is not None:
            self._loop.call_soon_threadsafe(job.queue.put_nowait, event)
        else:
            job.queue.put_nowait(event)

    async def run(self, job: Job, work: Callable[[ProgressFn, Callable[[], bool]], Any]) -> None:
        """Run a blocking `work(progress, is_cancelled)` in a thread, streaming progress."""
        job.state = JobState.running
        self._emit(job)

        def progress(value: float, message: str = "") -> None:
            job.progress = max(0.0, min(1.0, value))
            job.message = message
            self._emit(job)

        def is_cancelled() -> bool:
            return job.cancel_requested

        try:
            job.result = await asyncio.to_thread(work, progress, is_cancelled)
            job.state = JobState.done
            job.progress = 1.0
        except Exception as exc:  # noqa: BLE001 - surface any failure to the client
            job.state = JobState.error
            job.error = str(exc)
        self._emit(job)


jobs = JobManager()
