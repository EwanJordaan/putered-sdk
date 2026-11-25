# Publishing `@putered/sdk`

Publish from the repository root using an npm account with publish access to the `@putered` scope. Make sure two-factor authentication (2FA) is enabled on your npm account first.

## 1. Bump the version

Choose a version that has never been published (`patch`, `minor`, or `major`) and update both `package.json` and `package-lock.json`:

```sh
npm version patch --no-git-tag-version
```

Review the version diff before continuing.

## 2. Verify and publish

```sh
npm login --auth-type=web
npm whoami
npm test
npm pack --dry-run
npm publish --access public
```

Before confirming the publish, check the `npm pack --dry-run` file list. The published tarball should contain only:

- Compiled `dist/` output
- `package.json`, `README.md`, `putered.config.example.json`
- `LICENSE` and `NOTICE`
