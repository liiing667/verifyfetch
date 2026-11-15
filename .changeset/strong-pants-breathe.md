---
'verifyfetch': patch
---

Harden resumable downloads against corrupt or reused state. Stored chunks are
now re-hashed against the manifest before resuming (a corrupt or missing cache
restarts cleanly), 206 responses are strictly validated against the requested
Range interval and observed total size, servers that ignore Range (200 OK) or
return a wrong Content-Range fail closed with persisted state cleared, and the
assembled chunk list is checked against the manifest root before returning.
Normal resume flow, progress callbacks, and IndexedDB storage keys are
unchanged.
