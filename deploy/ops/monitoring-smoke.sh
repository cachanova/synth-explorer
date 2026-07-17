#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'monitoring-smoke: %s\n' "$*" >&2
  exit 1
}

curl_local() {
  curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 10 \
    --retry 12 --retry-delay 5 --retry-all-errors \
    "$@"
}

curl_local http://127.0.0.1:9090/-/ready >/dev/null \
  || die 'Prometheus did not become ready'

node_metrics="$(curl_local http://127.0.0.1:9100/metrics)" \
  || die 'node-exporter did not become ready'
grep -q '^node_load1 ' <<<"${node_metrics}" \
  || die 'node-exporter omitted host load metrics'
grep -q '^node_memory_MemAvailable_bytes ' <<<"${node_metrics}" \
  || die 'node-exporter omitted host memory metrics'

query=
for _ in {1..12}; do
  query="$(curl_local --get --data-urlencode \
    'query=synth_explorer_process_resident_memory_bytes' \
    http://127.0.0.1:9090/api/v1/query)" \
    || die 'Prometheus could not query application metrics'
  if jq --exit-status \
    '.status == "success" and (.data.result | length) == 1' \
    <<<"${query}" >/dev/null; then
    break
  fi
  sleep 5
done
jq --exit-status \
  '.status == "success" and (.data.result | length) == 1' \
  <<<"${query}" >/dev/null \
  || die 'Prometheus has not scraped application metrics'

grafana_health="$(curl_local http://127.0.0.1:3000/api/health)" \
  || die 'Grafana did not become ready'
jq --exit-status '.database == "ok"' <<<"${grafana_health}" >/dev/null \
  || die 'Grafana database is not healthy'

dashboard="$(curl_local \
  http://127.0.0.1:3000/api/dashboards/uid/synth-explorer-production)" \
  || die 'Grafana did not provision the production dashboard'
jq --exit-status \
  '.dashboard.uid == "synth-explorer-production"
    and .dashboard.title == "Production overview"' \
  <<<"${dashboard}" >/dev/null \
  || die 'Grafana production dashboard is invalid'

printf 'monitoring-smoke: Prometheus, node-exporter, and Grafana are ready\n'
