# Fintrail — DhanBoost in-house check APIs

The "Build in-house" checks from the DhanBoost vendor API research, as one basic API in two stacks.
Both expose the same endpoints.

| Endpoint | Body | Returns |
|---|---|---|
| `GET /api/health` | — | `{status}` |
| `POST /api/pan` | `{"pan":"ABCDE1234F"}` | format check only (`AAAAA9999A`) |
| `POST /api/email` | `{"email":"a@b.com","employer":"B Ltd"}` | MX lookup, disposable / free domain, employer match |
| `POST /api/address` | `{"lat":28.63,"lng":77.22,"pincode":"110001"}` | nearest pincode, distance, match |

## Run

```bash
# Next.js  -> http://localhost:3000
cd next-api && npm install && npm run dev

# Spring Boot (Java 21) -> http://localhost:8080
cd springboot-api && mvn spring-boot:run
mvn test   # runs the PAN + address checks
```

## Notes

- `pincodes.csv` is an 8-row sample. Replace it with the full
  [All India Pincode Directory](https://ndp.ckan.civicdatalab.in/dataset/all-india-pincode-directory)
  (columns `pincode,lat,lng`) for real use.
- Disposable / free email lists are tiny built-ins; swap in
  [kickmail](https://github.com/noticeable-app/kickmail) for production.
- PAN existence and mailbox-exists checks are deliberately not done (need Protean / port 25).
