# Quick Docker Deployment

## Windows

1. Install Docker Desktop.
2. Open `.env` and set the required values.
3. Double-click `START-WINDOWS.bat`.
4. Open `http://localhost:8080`.

To stop the portal, run `STOP-WINDOWS.bat`.

## Linux/macOS

```bash
cp .env.example .env
# edit .env
chmod +x START-WINDOWS.bat 2>/dev/null || true
docker compose up -d --build
docker compose exec app npm run seed
```

Use a reverse proxy and HTTPS before exposing the portal to the public internet.
