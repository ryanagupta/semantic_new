#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf '%s\n' 'Run with sudo: sudo bash deploy/provision-oracle.sh relay.example.com admin@example.com' >&2
  exit 1
fi
domain=${1:-}
email=${2:-}
if [[ ! $domain =~ ^([a-zA-Z0-9][a-zA-Z0-9-]*\.)+[a-zA-Z]{2,63}$ ]] || [[ ! $email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  printf '%s\n' 'Supply a public domain and a valid ACME contact email.' >&2
  exit 1
fi
source /etc/os-release
if [[ $ID != ubuntu ]]; then
  printf '%s\n' 'This provisioning script supports Ubuntu Server only.' >&2
  exit 1
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl nginx certbot python3-certbot-nginx iptables-persistent sqlite3
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
architecture=$(dpkg --print-architecture)
codename=${UBUNTU_CODENAME:-$VERSION_CODENAME}
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${codename}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker nginx

# Insert before the Oracle Ubuntu image's terminal REJECT rule without changing
# its SSH rules or flushing any existing firewall configuration.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || \
    iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
  if command -v ip6tables >/dev/null; then
    ip6tables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || \
      ip6tables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
  fi
done
netfilter-persistent save

sed "s/__RELAY_DOMAIN__/${domain}/g" "$script_dir/relay.nginx.conf" > /etc/nginx/sites-available/relay
ln -sfn /etc/nginx/sites-available/relay /etc/nginx/sites-enabled/relay
nginx -t
systemctl reload nginx
certbot --nginx --non-interactive --agree-tos --redirect --email "$email" --domain "$domain"
systemctl enable --now certbot.timer
printf '%s\n' 'Host packages, firewall rules, and TLS are configured. Next configure Relay secrets and start the Compose stack as documented in docs/scraper-deployment.md.'
