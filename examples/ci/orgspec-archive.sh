#!/bin/sh
# Post-merge step on the default branch: archive changes whose PR merged, then commit the updated specs.
set -eu
for id in $(orgspec list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const c of JSON.parse(s).changes){if(c.planningComplete&&c.tasks&&c.tasks.done===c.tasks.total)console.log(c.id)}})'); do
  orgspec archive "$id" --ci
done
if [ -n "$(git status --porcelain orgspec)" ]; then
  git add orgspec
  git commit -m "Archive merged OrgSpec changes"
  git push origin HEAD
fi
