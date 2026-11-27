# RKE2 bootstrap checks

Use for new RKE2 hosts, CNI readiness failures, controller kubeconfig export and DNS bootstrap. Verify details against the pinned RKE2 release and role source; examples are not global cluster defaults.

## Establish the bootstrap path

- Inspect the selected role's defaults, argument specification, templates and restart handlers. Render fragile inputs through that exact role in a sanitized local fixture. A role can advertise an inaccurate element type or require a rewrite as YAML text; a handwritten approximation does not validate the consumed interface.
- RKE2 watches its server manifests directory for supported manifest filenames. An Ansible source can be a Jinja template, but the installed manifest must have a supported `.yaml` or `.yml` filename. Confirm the live `HelmChartConfig` exists and its name/namespace match the packaged `HelmChart`; copying a file successfully does not establish that RKE2 consumed it.
- With Cilium kube-proxy replacement, establish the API path before service routing exists. Supply a reachable control-plane host and port using the selected Cilium chart's supported keys. Check the rendered values and Cilium logs for the actual API endpoint. A timeout to the Kubernetes service IP during initial CNI startup calls for fixing this dependency, not extending the node-ready timeout.

## Separate API consumers

The server's local kubeconfig and the operator workstation's exported kubeconfig can require different API endpoints. Inspect the generated `server` field instead of assuming it always contains `127.0.0.1`: it can use a private bind address or IPv6. Change only that field in the exported copy, preserve CA/client credentials, protect file permissions and ensure the chosen external hostname/IP is covered by the server certificate SANs and network policy.

Verify the exported config from its actual consumer with an explicit kubeconfig path. A successful API call on the VM does not prove workstation access. Keep unrelated user contexts unchanged.

## Distinguish DNS transport from CNI routing

Compare the same external DNS query over UDP and TCP from the host and a pod network context. Check internal service resolution separately. Host resolution can succeed because systemd-resolved has already fallen back to TCP while CoreDNS continues using UDP; inspect resolver state before blaming Cilium.

If the upstream path demonstrably blocks UDP/53 while TCP works, configure forwarding transport through the owning CoreDNS configuration. Preserve the complete required server/plugin structure from the exact packaged chart; replacing a list can silently remove defaults. Render with the target Kubernetes version and the RKE2 `HelmChart.spec.set` values as well as `HelmChartConfig`. Verify internal and external names after rollout. Prefer restoring the network path when that is within the task's scope.

## Acceptance

After the authorized convergence, verify node readiness, Cilium status and kube-proxy replacement, API access from each required consumer and DNS from pods. Check the installed manifest names and effective chart configuration. Registry changes belong in RKE2's managed registry configuration, with the service restart performed by Ansible handlers; generated containerd files are verification evidence, not the edit target.

Sources: [RKE2 Helm integration](https://docs.rke2.io/helm), [registry configuration](https://docs.rke2.io/install/private_registry), [Cilium kube-proxy replacement](https://docs.cilium.io/en/stable/network/kubernetes/kubeproxy-free/), [CoreDNS forward](https://coredns.io/plugins/forward/).
