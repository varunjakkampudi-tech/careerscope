# Operations — Firewall

## The rule that matters most

**Never run `nft flush ruleset`.**

Docker installs its NAT rules into the shared nftables ruleset. Flushing
globally deletes them. Containers then lose outbound connectivity, and the
symptom is not a firewall error — it is an opaque timeout somewhere else
entirely. This has already cost one twenty-minute debugging session on this
project, where the visible failure was `apt-get` hanging inside an image build.

The firewall therefore owns exactly one table, `inet careerscope`, and replaces
only that table.

## Layers

### 1. Hostinger managed firewall

Configured in hPanel, outside the host. Intended policy:

| Port            | Action                   |
| --------------- | ------------------------ |
| 22              | allow                    |
| 80              | allow                    |
| 443             | allow                    |
| everything else | deny unsolicited inbound |

**Status: NOT CONFIGURED.** The OS firewall below is currently the only inbound
layer. This is a real gap in defence in depth and is recorded in
[KNOWN-LIMITATIONS](../KNOWN-LIMITATIONS.md).

### 2. OS firewall (nftables)

Table `inet careerscope`, input policy `drop`, allowing:

- loopback
- `established,related`
- SSH (22), HTTP (80), HTTPS (443)
- the ICMP and ICMPv6 types required for path MTU discovery and neighbour
  discovery — dropping these breaks IPv6 and large packets in ways that look
  like application bugs

### 3. Network namespace

The strongest layer, and the one that is easy to miss. Every container except
the proxy uses `network_mode: service:proxy` and binds loopback. Postgres,
Redis, LocalStack and the API do not listen on any routable address. Even with
no firewall at all, they would be unreachable from the network.

### 4. fail2ban

`inet f2b-table`, maintained independently. See
[HOSTINGER](HOSTINGER.md#brute-force-protection).

## Verification

[check-host-firewall.sh](../../infra/v3/check-host-firewall.sh) — 14 assertions:

| Group      | Checks                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| Ownership  | the `careerscope` table exists; input policy is `drop`                                     |
| **Docker** | `ip nat` table present; Docker NAT rules present; a container can still reach the internet |
| Exposure   | 22, 80, 443 listening; 5280, 5390, 5432, 6379, 4566 not externally reachable               |
| Publishing | only the proxy publishes ports                                                             |

The Docker group exists specifically to catch a repeat of the flush regression.
Run this script after any firewall change, after restarting Docker, and after a
reboot.

```
bash /opt/careerscope/infra/v3/check-host-firewall.sh
```

## Changing the rules

Edit the ruleset, reload, then immediately re-run the verification script from a
**second** SSH session that is already open. If the reload locks you out, the
open session is the escape hatch; if that fails too, use the hPanel console.
