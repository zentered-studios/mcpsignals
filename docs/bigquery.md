# BigQuery setup

The `bigquery` sink streams rows into two tables via `insertAll`
(`tabledata.insertAll`/`insert_rows_json` under the hood). It does not
create the dataset or tables for you - do that once, up front.

## 1. Create the dataset and tables

The `CREATE TABLE` statements live in
[`schema/events.md`](../schema/events.md#bigquery) - copy them as-is. The
quickest way to run them is `bq query`, or paste them into the BigQuery
Studio SQL editor in the Cloud console:

```sh
bq query --use_legacy_sql=false < schema-bigquery.sql
```

(where `schema-bigquery.sql` is the BigQuery section of `schema/events.md`
saved to a file - `bq` doesn't read Markdown directly).

This creates `mcpsignals.tool_call` and `mcpsignals.session_summary`,
partitioned by day on `ts` and clustered by `server_name` (and `tool_name`
for `tool_call`), which keeps queries scoped to a date range cheap as the
tables grow.

If you want a different dataset or table names, create them under whatever
names you like and pass them to the sink explicitly (see below) - nothing
in `mcpsignals` assumes the `mcpsignals` dataset name except the sink's own
default.

## 2. Set up credentials

The sink authenticates the same way the underlying Google Cloud client
library always does: **Application Default Credentials (ADC)**. There is no
`mcpsignals`-specific credential config, per the project's "no invented
config file format" rule.

The common cases:

| Where you're running | How ADC resolves |
|---|---|
| Locally | `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file's path |
| On GCP (Cloud Run, GKE, Compute Engine, Cloud Functions) | Automatic, via the metadata server - attach a service account with the right role to the workload, no env var needed |
| Anywhere else (your own servers, CI) | Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json` |

The service account (or your own user credentials, locally) needs at least
**BigQuery Data Editor** on the dataset, so it can insert rows. It does not
need Job User / query permissions - the sink only streams inserts, it never
runs a query.

Project ID resolves in the client library's own standard order: the
`projectId` (Node.js) / `project` (Python) option you pass to the sink, else
the `GOOGLE_CLOUD_PROJECT` environment variable, else the project embedded
in the credentials, else (on GCP) the metadata server. You only need to
pass `projectId`/`project` explicitly if none of those apply.

## 3. Configure the sink

Node.js - the dataset defaults to `mcpsignals`, matching the DDL above:

```ts
import { bigquerySink } from 'mcpsignals';

bigquerySink(); // dataset: 'mcpsignals', tables: tool_call / session_summary, ADC credentials

bigquerySink({ projectId: 'my-gcp-project', dataset: 'my_custom_dataset' });
```

Python - `dataset` has no default, pass it explicitly:

```python
from mcpsignals.sinks import BigQuerySink

BigQuerySink(dataset="mcpsignals")  # ADC credentials, project resolved automatically

BigQuerySink(dataset="my_custom_dataset", project="my-gcp-project")
```

## Notes

- Writes go through `asyncio.to_thread` in Python (the official
  `google-cloud-bigquery` client is synchronous) so a slow insert never
  blocks your server's event loop. The Node.js client is natively async.
- `insertAll`/`insert_rows_json` is BigQuery's low-latency streaming path.
  Rows can take a short while to become visible to `SELECT` (usually
  seconds), and very recently streamed rows aren't eligible for
  `UPDATE`/`DELETE` until they've settled - normal BigQuery streaming-insert
  behavior, not something this sink works around.
- A failing insert is caught, logged once, and dropped - per the project's
  "a broken sink must never break the host server" rule, `mcpsignals` does
  not retry or buffer failed BigQuery writes beyond the sink's own event
  buffer.
