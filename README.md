# Monster Pop TD

An 8-bit monster tower defense game with player accounts and cloud saves.

- `public/index.html` is the whole game (one self-contained page).
- `server.js` serves the game and a small JSON API for accounts and saves.
- `pg-lite.js` is a tiny built-in PostgreSQL client, so the server has **no npm dependencies**.

## Running

Requires Node 18+ and a PostgreSQL database.

```sh
DATABASE_URL=postgres://user:pass@host:5432/db PORT=3000 node server.js
```

The server creates its tables on startup.

| Env var        | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `DATABASE_URL` | Postgres connection string (required)                      |
| `PORT`         | Port to listen on (Render sets this automatically)         |
| `PGSSLMODE`    | Optional; `require` is used automatically for Render hosts |

## Accounts

- Usernames: 3–20 letters, numbers or underscores. Passwords: 8+ characters.
- Passwords and recovery codes are hashed with scrypt; sessions use an HttpOnly cookie.
- There is no email. A recovery code shown at sign-up is the only way to reset a forgotten password.
- Players who don't log in still have their progress saved in their browser.

## API

| Method | Path          | Purpose                                  |
| ------ | ------------- | ---------------------------------------- |
| GET    | `/api/me`     | Current user (or `null`)                 |
| POST   | `/api/signup` | Create account, returns recovery code    |
| POST   | `/api/login`  | Log in                                   |
| POST   | `/api/logout` | Log out                                  |
| POST   | `/api/reset`  | Reset password with recovery code        |
| GET    | `/api/save`   | Load cloud save                          |
| PUT    | `/api/save`   | Store cloud save (merged server-side)    |
| POST   | `/api/delete` | Delete account (needs password)          |
| GET    | `/healthz`    | Health check                             |

Write requests must send `Content-Type: application/json` and `X-MPTD: 1`.
