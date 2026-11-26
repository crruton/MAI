# Preview and read-only inspection

Use the commands matching the diagnosed object and its actual source path.

## Commands

```bash
# Preview an MR's effect on the cluster (server-side dry run). Exit 0 no diff, 1 diff, >1 error.
flux diff kustomization <name> --path ./clusters/<name>/apps/<app>
flux diff kustomization <name> --path ./clusters/<name>/apps/<app> --kustomization-file clusters/<name>/apps/flux-ks.yaml
flux diff kustomization <name> --path ./clusters/<name>/apps/<app> --recursive --local-sources GitRepository/flux-system/flux-system=.

# Render without a cluster diff
flux build kustomization <name> --path ./clusters/<name>/apps/<app> --dry-run

# State (read-only)
flux get kustomizations -A
flux get helmreleases -A
flux get sources all -A
flux get kustomizations -A --status-selector ready=false
flux tree kustomization <name>
flux events --for Kustomization/<name> -n flux-system
flux logs --kind Kustomization --name <name> -n flux-system --since 15m
```

`flux diff` needs read access to the cluster and, for Secrets, shows masked values; do not paste its Secret hunks into an MR. `--path` is the local directory matching `spec.path`.
