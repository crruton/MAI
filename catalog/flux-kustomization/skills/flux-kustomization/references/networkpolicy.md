# NetworkPolicy authoring

NetworkPolicies are additive allow-lists. A pod selected by any policy for a direction (Ingress or Egress) is denied everything in that direction except what some policy allows. Pods selected by no policy are open. Enforcement needs a CNI that implements it (Cilium, Calico); on one that does not, policies silently do nothing, so confirm in a test namespace.

## 1. Default deny per namespace

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

Use namespace-wide isolation only when it matches the project's tenancy model. Inventory dependency traffic first and prepare default-deny with its allows in one change. Git ordering alone does not make application atomic: plan staged rollout and connectivity checks through the authorized deployment process.

## 2. DNS egress for isolated pods

When egress is isolated and no other policy permits the resolver path, DNS needs an allow. An ingress-only policy does not restrict egress. The example assumes cluster DNS Pods; inspect the real resolver path for NodeLocal DNSCache or CNI-specific behavior.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - {port: 53, protocol: UDP}
        - {port: 53, protocol: TCP}
```

Check the actual DNS labels in the cluster (`kubectl get pods -n kube-system --show-labels`); CoreDNS commonly carries `k8s-app: kube-dns`, while NodeLocal DNSCache or Cilium setups can differ.

## 3. App allow rules

Ingress from the ingress controller to the app port:

```yaml
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: api}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - {port: 8080, protocol: TCP}
```

Egress to a database in another namespace:

```yaml
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: api}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: databases}
          podSelector:
            matchLabels: {app.kubernetes.io/name: postgres}
      ports:
        - {port: 5432, protocol: TCP}
```

## Rules

- `namespaceSelector` and `podSelector` in the same `from`/`to` entry are ANDed (pod in that namespace). As two separate list items they are ORed (any pod in the namespace, plus any pod with the label in this namespace). Indentation decides; verify by rendering.
- Select namespaces with the built-in label `kubernetes.io/metadata.name`, which exists on every namespace, not custom labels.
- Always list `ports`; an entry with no `ports` allows all ports.
- Empty `ingress: []` or `egress: []` with the direction listed isolates that direction without adding allows; another policy can still allow it. Set `policyTypes` explicitly: when the field is absent, Ingress is defaulted, and Egress is also defaulted when egress rules are present.
- Allow only what the app needs, discovered from its config (service names, ports), not from guessing. Typical egress needs: DNS, database, cache, message broker, other services, external APIs (by `ipBlock` CIDR; policies cannot match DNS names unless the CNI supports FQDN policies, e.g. Cilium `toFQDNs`).
- Don't forget: Prometheus scraping the metrics port (ingress from the monitoring namespace), kubelet probes (node traffic is normally allowed by CNIs, but verify on yours), webhooks and the API server for apps that call it (`ipBlock` of the API server, or CNI entity rules).
- `ipBlock` with `except` for broad CIDRs; avoid `0.0.0.0/0` egress unless the app genuinely needs the internet, and say why in the MR.
- One policy per concern, named for what it allows (`allow-dns`, `api-from-ingress`).

## Validate

```bash
kubeconform -strict -summary netpol.yaml
kube-linter lint netpol.yaml
flux diff kustomization <name> --path <dir>
```

Behavioral testing needs an authorized test cluster/identity and the project's deployment process. Test both allowed and denied source/destination/port cases, including DNS and monitoring. Pod readiness alone does not prove isolation or dependency connectivity. Record what was actually exercised.

Source: [Kubernetes NetworkPolicy semantics](https://kubernetes.io/docs/concepts/services-networking/network-policies/).
