# IMA web protocol core — local extraction

This experimental Node 22 package was extracted from IMA QA Web Agent. Its
original source hashes and MIT license are preserved, with the source commit
in `docs/source-provenance.json`. Later independent implementation changes are
explicitly recorded in `docs/local-protocol-revisions.json`; the original
extraction record is not rewritten to pretend those changes came from upstream.

It accepts explicitly injected authentication, device context and transport.
Importing the package does not read a profile, log in, refresh credentials,
start a service or run a browser. It does not require Provider A. The independent
runtime now provides its own personal profile and SDK/CLI/MCP adapters. The
scoped+web composition in S4.9 is synthetic-tested and awaits live acceptance.

The copied extraction baseline is historical provenance, not a promise that
future development must keep implementation bytes unchanged. Current direct
protocol evidence and future application acceptance must remain distinct.
