# Robot authentication and permissions

## Choose the scope

Map each requested operation to a Harbor API resource/action and project before
creating the account. Login alone does not define the permissions a task needs.
Use a project robot for one project. Use a system robot only for required system
operations or access across explicitly named projects; a system robot need not
receive all system privileges or access to every current and future project.

The following project grants are starting points for the named endpoints, not a
universal read-only role. Check the target server's permission reference and any
additional API calls made by the installed CLI.

| Required operation | Resource | Actions |
|---|---|---|
| Pull OCI content | `repository` | `pull` |
| Push OCI content | `repository` | `pull`, `push` |
| List repositories in a known project | `repository` | `list` |
| Read one repository's metadata | `repository` | `read` |
| List artifacts in a known repository | `artifact` | `list` |
| Read one artifact's metadata | `artifact` | `read` |
| List tags | `tag` | `list` |
| Read vulnerability additions | `artifact-addition` | `read` |
| Start a scan | `scan` | `create` |
| Read a scan log | `scan` | `read` |

Push requires pull. Pull does not imply repository or artifact listing through
the management API. Add only the rows needed by the task; avoid `*`, Select All,
`--all-permission`, unrelated delete privileges and automatic coverage of future
projects. Ordinary project robot grants cover the project, not a single named
repository; do not describe them as repository-isolated credentials.

## Provision without exposing the secret

Use an existing authorized administrator session for bootstrap. If unavailable,
prepare the exact project, grants, purpose and expiry for its owner; a robot
cannot bootstrap itself. In the WebUI, a project administrator can use Projects
→ the target project → Robot Accounts → New Robot Account. System robots are
created under Administration → Robot Accounts by a system administrator.

For CLI provisioning, copy and adapt the
[project robot template](../templates/project-robot.yaml). Its example grants
only artifact listing in `example-project` for 30 days. Replace the project,
purpose, duration and actions with the actual requirements before execution.
Use a finite lifetime aligned with the consumer's rotation process.

The CLI 0.0.27 parser uses top-level `level`, and nested scopes with `kind`,
`namespace`, and `access`. Some upstream examples instead show top-level `kind`
or a flat `project`/`permissions` format; those examples do not match this parser.
For a system robot, use `level: system` with explicit project scopes and only
necessary system scopes (`kind: system`, `namespace: /`). Verify against the
installed version before adapting the template.

Run creation from a private directory outside the repository, with `umask 077`,
using the bootstrap context. CLI 0.0.27 exports `<full-robot-name>-secret.json`
into the working directory:

```bash
harbor project robot create --robot-config-file /absolute/path/robot.yaml --export-to-file
```

For an approved system robot, use `harbor robot create` with the corresponding
system configuration. Do not combine creation/export with `-o json` or `-o yaml`
in 0.0.27: its formatted-output branch bypasses secret export. Without export,
creation can display the secret and copy it to the clipboard.

Verify that the private export exists with restrictive permissions and contains
nonempty name/secret fields without printing their contents. Store the secret in
the approved secret manager; remove the temporary export after transfer is
verified. Harbor returns the new secret only at creation or refresh. If export
fails after creation, check the account's existence before retrying. Refresh is
a credential rotation that may break consumers, not a read operation.

## Log in as the robot

Copy the full username from Harbor. With the default prefix, a project robot
looks like `robot$example-project+example-cli`; a system robot looks like
`robot$example-cli`. Prefixes are configurable. Quote literal names with single
quotes so the shell does not expand `$`.

For real interactive credentials, prefer hidden input in a private terminal:

```bash
harbor login harbor.example.com -u 'robot$example-cli' --context-name example-cli --password-stdin
harbor context switch example-cli
```

In 0.0.27, `--password-stdin` calls `term.ReadPassword` and requires terminal
stdin; a secret-manager pipe can fail with an ioctl error. Do not assume Docker's
pipe behavior. For unattended use, verify the installed release's input support
and the approved secret-delivery mechanism first. `-p` exposes the password in
process arguments; shell expansion avoids a literal history entry but does not
remove that exposure. Keep actual values out of agent tool arguments and logs.
Protect the CLI configuration and its encryption-key storage as credentials.

## Verify and diagnose

Select the robot context and check its non-secret server/username fields, then
perform a bounded operation that the account was granted on a known private
resource. Use the OCI client for a pull-only account instead of granting list
permissions solely to make an API listing check pass. Verify writes only within
the requested task; a successful read cannot prove push/delete capability.

Separate wrong/expired secrets or a disabled robot (401), denied API permissions
(403), and DNS/VPN/TLS failures. Fix trust or connectivity without disabling TLS
verification. Confirm the exact username, context and expiry before rotating.

CLI 0.0.27 validates login through current-user information, with project-list
and ping fallbacks for some errors. These checks can conflict with a narrowly
scoped robot and are not proof of task-specific authorization. Do not add broad
permissions merely for the login probe. If a verified version-specific probe
limitation requires `--skip-verify-client`, explain that it only stores credentials
without validation and immediately verify the intended authenticated operation.
Do not use it to conceal invalid credentials or an unreachable server.

Sources:

- [Project robot accounts](https://goharbor.io/docs/2.14.0/working-with-projects/project-configuration/create-robot-accounts/)
- [System robots and permission reference](https://goharbor.io/docs/2.14.0/administration/robot-accounts/)
- [CLI 0.0.27 login implementation](https://github.com/goharbor/harbor-cli/blob/v0.0.27/cmd/harbor/root/login.go)
- [CLI 0.0.27 robot config parser](https://github.com/goharbor/harbor-cli/blob/v0.0.27/pkg/config/robot/robot.go)
- [CLI 0.0.27 project robot creation/export](https://github.com/goharbor/harbor-cli/blob/v0.0.27/cmd/harbor/root/project/robot/create.go)
