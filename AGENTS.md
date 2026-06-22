# AGENTS.md

## Cursor Cloud specific instructions

This is a minimal Node.js / Express web app (scaffolded by `express-generator`). It is the only service.

- **Run (dev):** `npm start` (runs `node ./bin/www`). Serves on `http://localhost:3000` (override with `PORT`). There is no hot-reload/watcher configured.
- For development error stack traces, start with `NODE_ENV=development`.
- **Routes:** `GET /` renders the Pug `index` view ("Welcome to Express"); `GET /users` returns the stub text "respond with a resource".
- **Lint:** no linter is configured.
- **Test/Build:** no `test` or `build` scripts are defined in `package.json`; `npm test` will fail because no test script exists.
- Dependencies are installed via `npm install`; `node_modules` is gitignored.
