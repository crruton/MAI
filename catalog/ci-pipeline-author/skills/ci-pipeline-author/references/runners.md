# Runner selection from the actual environment

Resolve the effective job tags after `workflow:rules:variables`, job rules and inheritance. Record architecture, executor, build capabilities, target network and resource class. Preserve a project's default build runner and separate test pools; do not replace a dynamic tag expression with a fixed example tag.

## Resource classes

Inspect the available memory/CPU class tags and effective limits. Include parallel workers and service containers when sizing a job; select a verified larger class when necessary.

GitLab requires a runner to match every job tag. Replace the old resource-class tag when moving classes; do not append competing classes as alternatives. Job-level tags replace inherited/default tags, so retain required architecture, executor and network tags. Confirm a project-eligible runner matches the full set.

## Network and cache

GitLab's host does not imply where the runner lives. Use the project’s registry and proxies only where reachable, including through corporate VPN. Check recent traces and actual routing. Discover shared S3/MinIO vs local/slot caching per pool; a global comment is not evidence.

For customer-network deployment, a customer-side runner can keep deployment credentials and network access local. Propose placement based on reachability and ownership, not as a universal CI requirement. Executor, registry, cache, namespaces and credentials are project-specific; do not register runners or create tokens incidentally.

## Build capabilities and trust

The werf/Kubernetes profile uses unprivileged runners with Buildah prerequisites; see [build-and-deploy.md](build-and-deploy.md). An established Docker host-daemon pipeline has a different trust model and layer-cache locality. Do not confuse `docker.sock` with dind or migrate it during performance work without owner scope. Review privileged access separately if the task calls for a security change.

If a required class/network combination is unknown or unavailable, give the owner the missing capability; do not ship a made-up tag as a working configuration.

For worker crashes or capacity incidents, use [runner resource diagnosis](runner-resources.md). Identify job → runner ID → manager → physical host/node; runner-name suffixes do not prove co-location.
