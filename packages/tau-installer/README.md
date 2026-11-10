# Tau Installer

`@right9/oio-installer` installs Tau globally. On npm 11.16 and newer, it
allows only Tau's reviewed npm lifecycle scripts for that single install
command. Older npm versions use npm's normal lifecycle-script behavior because
they do not support the command-scoped policy.

Node.js 20.18.1 or newer is required.

## Install or update to the latest Tau

```sh
npx -y @right9/oio-installer@latest
```

## Install an exact Tau version

Tau's updater can pin the release it already selected:

```sh
npx -y @right9/oio-installer@latest --oio-version 0.92.15
```

`--oio-version` accepts an exact semantic version only. Tags and ranges such as
`latest`, `^0.92.15`, and `0.92.x` are rejected.

## Inspect without installing

```sh
npx -y @right9/oio-installer@latest --dry-run
```

The installer has no dependencies and no lifecycle scripts of its own. It runs
the invoking npm CLI with `shell: false`. On npm 11.16 and newer, it passes the
reviewed list through a command-line `--allow-scripts` option. It never runs
`npm config set` and never changes the user's persistent npm configuration.

For this command only, the installer also disables inherited `ignore-scripts`
and `dangerously-allow-all-scripts` settings, disables inherited npm dry-run
and package-lock-only modes, forces executable bin links, includes supported
optional dependencies, and, where supported, enables strict script policy. On
npm 11.16 and newer, required reviewed scripts can run while an unreviewed
dependency script stops the install.

The installer checks the invoking npm version first. npm 11.16 and newer receive
the command-only `--allow-scripts` list. Older npm versions omit that unsupported
option because they run lifecycle scripts normally.

Tau's release tests derive the reviewed list from `package-lock.json` and fail
when a production dependency adds or removes an install script. This keeps the
installer policy explicit without changing users' persistent npm configuration.
