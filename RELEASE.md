# Where Browser Release Guide

## Auto-Update System

Where Browser includes an auto-update system powered by electron-updater. Updates are automatically checked 30 seconds after app launch and users are notified when new versions are available.

## Release Hosting Options

### 1. GitHub Releases (Recommended)
The app is configured to use GitHub Releases as the update server. This is free and reliable.

**Setup:**
1. Updates are automatically published when you create a new release on GitHub
2. The GitHub Actions workflow handles building and uploading assets
3. No additional server setup required

### 2. Custom Update Server
For testing or private releases, you can host your own update server.

**Requirements:**
- Static file hosting (nginx, Apache, S3, etc.)
- HTTPS certificate (required for production)
- Ability to serve large binary files

**Server Structure:**
```
/releases/
  ├── latest-mac.yml
  ├── Where-0.1.0-mac.zip
  ├── Where-0.1.0-mac.zip.blockmap
  ├── latest.yml
  ├── Where-0.1.0.exe
  ├── Where-0.1.0.exe.blockmap
  └── ... (other platform files)
```

## Creating a Release

### 1. Update Version
```bash
# Update version in package.json
pnpm version patch  # or minor/major
```

### 2. Create Git Tag
```bash
git add .
git commit -m "Release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

### 3. GitHub Actions
The workflow will automatically:
- Build for macOS, Windows, and Linux
- Sign macOS builds (if certificates are configured)
- Create a GitHub Release
- Upload all distributables

### 4. Manual Release (Alternative)
```bash
# Build locally
pnpm run make

# Files will be in out/make/
```

## Testing Updates

### Local Testing
1. Build the app: `pnpm run make`
2. Install the built app
3. Start a local update server:
   ```bash
   cd out/make
   python3 -m http.server 8080
   ```
4. The dev build will check `http://localhost:8080` for updates

### Production Testing
1. Install current version from GitHub Releases
2. When a new version is released, the app will notify users
3. Users can choose to download and install immediately or later

## Environment Variables

Required for signed builds:
- `APPLE_IDENTITY`: Developer ID certificate name
- `APPLE_ID`: Apple ID for notarization
- `APPLE_ID_PASSWORD`: App-specific password
- `APPLE_TEAM_ID`: Apple Developer Team ID
- `GH_TOKEN`: GitHub token for publishing releases

## Troubleshooting

### Updates Not Working
1. Check console logs for errors
2. Verify update server is accessible
3. Ensure version numbers are incrementing properly
4. Check that update files match expected format

### Code Signing Issues
1. Verify certificates are installed: `security find-identity -v -p codesigning`
2. Check entitlements.plist is correct
3. Ensure app-specific password is valid
4. Test locally before pushing to CI

### Platform-Specific Notes

**macOS:**
- Requires code signing for updates to work
- Notarization recommended for distribution outside App Store

**Windows:**
- Code signing optional but recommended
- Squirrel.Windows handles updates

**Linux:**
- AppImage format recommended for auto-updates
- Ensure proper permissions on update files