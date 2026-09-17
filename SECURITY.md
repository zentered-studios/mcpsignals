# Security Policy

## Supported Versions

mcpsignals ships as two independently versioned packages:

- [`mcpsignals` on npm](https://www.npmjs.com/package/mcpsignals) (`packages/node`)
- [`mcpsignals` on PyPI](https://pypi.org/project/mcpsignals/) (`packages/python`)

Both are pre-1.0. Only the latest published release of each package is
supported with security fixes. Upgrade to the latest version before
reporting an issue.

## Reporting a Vulnerability

Report suspected vulnerabilities privately through GitHub:

1. Go to the [Security tab](https://github.com/zentered-studios/mcpsignals/security).
2. Click **Report a vulnerability** to open a private advisory.

Do not open a public issue for a suspected vulnerability.

Name the affected package (`mcpsignals` npm, `mcpsignals` PyPI, or both) and
version. Give steps to reproduce, or a minimal repro. State the impact -
what an attacker can do, what data is exposed.

We will acknowledge new reports within 5 business days and aim to ship a fix
or mitigation within 30 days, depending on severity and complexity. We will
credit reporters in the advisory unless asked not to.

## Scope

In scope: the `packages/node` and `packages/python` libraries in this
repository, including their build and release workflows.

Out of scope: vulnerabilities in the databases or warehouses a user
configures mcpsignals to write to (Postgres, BigQuery, etc.) - report those
to the respective vendor.
