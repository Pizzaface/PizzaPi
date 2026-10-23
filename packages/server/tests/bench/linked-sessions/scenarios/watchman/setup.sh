#!/bin/sh
# Runs inside the fixture repo after the initial commit: a local bare "origin".
set -e
git init -q --bare ../remote.git
git remote add origin ../remote.git
git push -q origin HEAD:main
