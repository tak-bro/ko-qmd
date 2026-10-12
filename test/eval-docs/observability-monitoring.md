# Observability and Monitoring Guide

## Introduction

Observability is the ability to understand the internal state of a system from its external outputs. This guide covers the three pillars of observability: metrics, logs, and traces, plus alerting rules that keep on-call engineers sane.

## Metrics with Prometheus

We collect time-series metrics with Prometheus. Every service exposes a `/metrics` endpoint with RED indicators: rate, errors, and duration.

Key metrics to track for service health:
- Request rate (requests per second per endpoint)
- Error rate (5xx responses as a fraction of total traffic)
- Latency percentiles (p50, p95, p99 response times)
- Saturation (CPU, memory, disk, and connection pool usage)

Example Prometheus alerting rules live in `prometheus/rules.yml`. A typical rule fires when the p99 latency exceeds 800ms for more than 10 minutes, or when the error rate crosses 1% over a 5-minute window.

## Dashboards for Service Health

Grafana dashboards give every team a single pane of glass for service health. Our standard dashboard set includes:
- Service overview (traffic, errors, latency per endpoint)
- Saturation board (CPU, memory, disk, queue depth)
- Dependency map (downstream latency and error contribution)
- Deployment markers (annotations showing each rollout)

Dashboard reviews happen monthly; stale panels get deleted so the dashboards stay trustworthy.

## Distributed Tracing with OpenTelemetry

We instrument services with OpenTelemetry for distributed tracing. Each incoming request gets a trace ID that propagates across service boundaries via W3C trace context headers.

To control costs, we use tail-based trace sampling: the collector keeps 100% of error traces and slow traces but only 5% of healthy traffic. Sampling decisions are made after the full span is assembled, so rare failures are never dropped.

## Logs and Correlation

Structured JSON logs include the trace ID and span ID on every line, so engineers can jump from a dashboard spike to the exact log lines and then to the full trace. Log retention is 30 days for application logs and 90 days for audit logs.

## Error Budgets and Paging Policy

Each user-facing service defines an SLO, such as 99.9% successful responses over a 30-day window. The error budget is the allowed failure quota derived from that SLO.

Our error budget burn rate policy works as follows:
- Fast burn (budget consumed 10x faster than allowed) pages the on-call engineer immediately.
- Slow burn (2x faster than allowed) opens a ticket for the next business day.
- If the error budget is exhausted, feature releases freeze until reliability recovers.

## Incident Response

Monitoring alerts link directly to runbooks. Severity levels:
- SEV1: full outage, all hands, status page update within 15 minutes.
- SEV2: degraded experience, on-call plus service owner.
- SEV3: minor issue, fix during working hours.

Every incident ends with a blameless postmortem and at least one action item to improve detection.
