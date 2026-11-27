---
name: harbor-cli
description: Operate Harbor registries with the official harbor CLI. Use for robot-account authentication, least-privilege permissions, project/repository/artifact inspection, and requested registry changes or CLI access failures.
version: 1.0.0
owner: crruton
---

# Harbor CLI

Use the official `goharbor/harbor-cli` binary, named `harbor`. Establish the registry,
project, intended operations and existing execution authority from project context.
Ask for missing scope before choosing robot permissions. `harbor.example.com` is an
example target supplied by the user, not a default for other environments.

## Authenticate with a scoped robot

Use a dedicated robot account with only the permissions needed for the requested
operations. Reuse a suitable existing robot; otherwise create one through an
authorized administrator. Read [robot authentication](references/authentication.md)
before provisioning, logging in, handling secrets or diagnosing login failures.
Keep administrator bootstrap access separate from the operational robot context.

The login shape below contains a dummy password; single quotes preserve the `$`
in the username. Use the exact full username returned by Harbor.

```bash
harbor login harbor.example.com -u 'robot$example-cli' -p 'example-password'
```

## Execute the requested operation

1. Check `harbor version` and the relevant subcommand's `--help`. Use documentation
   for that version when syntax or permission requirements are uncertain. The
   examples here were checked against CLI 0.0.27; server capabilities vary too.
   If the CLI is missing, use the project's installation method or the official
   [installation instructions](https://github.com/goharbor/harbor-cli#install).
2. Select the intended context explicitly when multiple accounts exist. Inspect
   only non-secret fields; avoid dumping configuration or credentials.

   ```bash
   harbor context switch 'example-cli'
   harbor context get credentials.serveraddress
   harbor context get credentials.username
   ```

   `example-cli` must be a context created with `--context-name example-cli`, not
   an assumed default. Verify the registry and robot identity before any write.
3. Supply known project/repository names instead of interactive discovery. This
   avoids unrelated listing permissions. Start with a bounded read in the scope
   already granted to the robot. For a robot assigned the corresponding list
   permissions:

   ```bash
   harbor repo list example-project --page 1 --page-size 20 -o json
   harbor artifact list example-project/example-repository --page 1 --page-size 20 -o json
   ```

   Follow pagination when a complete inventory is requested. Inspect the actual
   JSON structure before scripting against it; output can include a response
   wrapper. A first page or an empty public project does not prove private access.
4. For changes, resolve the exact resource and use the installed command's help.
   Distinguish removing a tag from deleting an artifact digest and its other tags.
   Scope scans, retention, replication and deletion to the requested resources;
   a single-artifact task does not authorize project-wide or system-wide jobs.
   Perform writes within existing authorization and inspect the resulting state.
5. Verify the requested result using the robot identity. For asynchronous work,
   inspect the job's final status rather than equating request acceptance with
   completion. On 403, identify the denied endpoint and its resource/action before
   proposing a permission change; do not switch to administrator access to finish.

Harbor CLI manages Harbor's API resources. Use the project's OCI client for image
or chart transfer; `harbor login` does not establish Docker, Helm or other clients'
registry sessions.

Return the target, operation/result, verification evidence and any remaining
permission or connectivity limitation. Include robot scope and expiry when created,
but never the secret, exported credential contents or encryption key.

Sources: [official CLI](https://github.com/goharbor/harbor-cli),
[versioned command documentation](https://github.com/goharbor/harbor-cli/tree/v0.0.27/doc/cli-docs).
