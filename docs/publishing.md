# Publishing

The package is `@putered/sdk`. Publish from the repository root with the npm
account that owns the `@putered` scope or has publish access to this package.
For an organization scope, confirm the account is a member of the organization
and has write access to the package.
Enable two-factor authentication in your npm account settings before publishing.

```sh
npm login --auth-type=web
npm whoami
npm test
npm pack --dry-run
npm publish --access public
```

Complete the browser login and the 2FA prompts when npm requests them. Review
the dry-run file list before publishing; the package should contain its compiled
SDK, package metadata, license, notice, and README only.

Before each release, bump the version in `package.json` and `package-lock.json`
to a version that has never been published. For example, run
`npm version patch --no-git-tag-version`, then review both version fields and
the resulting changes before testing and publishing. Use `minor` or `major`
instead of `patch` when the API change requires it.
