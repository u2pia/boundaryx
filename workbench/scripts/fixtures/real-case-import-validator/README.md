# Import Validator

Small TypeScript application used by the repeatable AI Native SDLC Control Plane real-case runner.

The validator receives a file name and byte size and returns a structured validation result. Existing tests are the deterministic acceptance contract and must not be weakened or removed.

Run locally:

```bash
npm test
node scripts/build.mjs
```
