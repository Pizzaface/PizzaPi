# Pairing: docker-versioning

## Story
Dishes 001 and 002 ship as a single PR. Dish 001 creates the Dockerfile and GH Actions workflow; Dish 002 updates `pizza web` to consume the GHCR images. Together they form the complete Docker versioning story.

## Dishes
| # | Title | Role | Dependency |
|---|-------|------|------------|
| 001 | GH Actions + GHCR Dockerfile | prelim | none |
| 002 | Update pizza web to pull GHCR | main | 001 |

## Combined PR Title
feat: Docker image versioning for UI via GHCR

## Status
queued
