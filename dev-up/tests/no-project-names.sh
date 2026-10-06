#!/bin/sh
# Fails when a project's names leak into the engine. dev-up knows how to bring
# a stack up; what a stack is lives in the stack file, outside this repo.
# `claude plugin test` runs without file access, so this check is a script.
cd "$(dirname "$0")/.." || exit 2
if grep -rniwE 'lolc[a-z-]*|ekyc[a-z]*|oracle|keycloak|garage|galaxy_tab[a-z0-9_]*|expo|work/soc|herdr' --exclude=no-project-names.sh .claude-plugin/plugin.json hooks tests README.md 2>/dev/null; then
  echo "dev-up: the lines above name a project; move them to that project's stack file" >&2
  exit 1
fi
echo "dev-up: no project names"
