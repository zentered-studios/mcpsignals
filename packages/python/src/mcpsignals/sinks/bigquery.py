"""BigQuery sink. Requires the `bigquery` extra (google-cloud-bigquery).
Credentials come from Application Default Credentials, same as the client
library's own defaults - never an invented config file. The client library
is synchronous, so writes run in a thread via asyncio.to_thread and never
block the event loop.
"""

import asyncio
import dataclasses

from mcpsignals.events import SessionSummaryEvent, ToolCallEvent


class BigQuerySink:
    def __init__(self, dataset: str, project: str | None = None, client=None):
        self._dataset = dataset
        self._project = project
        self._client = client

    def _get_client(self):
        if self._client is None:
            from google.cloud import bigquery  # local import: don't require the SDK unless used

            self._client = bigquery.Client(project=self._project)
        return self._client

    def _row(self, event) -> dict:
        row = dataclasses.asdict(event)
        row.pop("event_type", None)
        row["ts"] = event.ts.isoformat() if event.ts else None
        return row

    def _insert_sync(self, table: str, rows: list[dict]) -> None:
        client = self._get_client()
        table_ref = f"{self._dataset}.{table}"
        errors = client.insert_rows_json(table_ref, rows)
        if errors:
            raise RuntimeError(f"bigquery insert errors for {table_ref}: {errors}")

    async def write(self, events: list[ToolCallEvent | SessionSummaryEvent]) -> None:
        tool_calls = [self._row(e) for e in events if isinstance(e, ToolCallEvent)]
        summaries = [self._row(e) for e in events if isinstance(e, SessionSummaryEvent)]

        if tool_calls:
            await asyncio.to_thread(self._insert_sync, "tool_call", tool_calls)
        if summaries:
            await asyncio.to_thread(self._insert_sync, "session_summary", summaries)
