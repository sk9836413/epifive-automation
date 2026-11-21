#!/usr/bin/env bash
# Mini-tools factory (mini-tools.yml): cloud version of the PC's release-tool.sh.
#   GH_TOKEN=<epifive org token> bash minitools/release-tool.sh <slug> <description> <topics comma list> <homepage> <zip>
# Publishes FREE (public epifive/<slug>) + PRO (private epifive/<slug>-pro) + release <slug>-pro-v1.0.0 (the zip) in
# private epifive/pro-releases. Repos are created private first and made public only after the push (as on the PC).
# Prints the public repo URL and the commit-author check ("EpiFive" only = good).
set -euo pipefail
s=$1; desc=$2; topics=$3; home=$4; zip=$5
push() { git -C "$1" push -q "https://x-access-token:${GH_TOKEN}@github.com/epifive/$2.git" HEAD:main; }

gh api "repos/epifive/$s" >/dev/null 2>&1 || gh repo create "epifive/$s" --private --description "$desc" --homepage "$home" >/dev/null
push "work/$s" "$s"
args=(); IFS=, read -ra T <<< "$topics"; for t in "${T[@]}"; do args+=(--add-topic "$t"); done
gh repo edit "epifive/$s" --visibility public --accept-visibility-change-consequences "${args[@]}" >/dev/null
# Public v1.0.0 release with a source zip, so downloads are countable (same naming as the other public repos).
# Created directly (no release.yml push: the org token may lack the workflows scope). Never fails the run.
if ! gh release view v1.0.0 -R "epifive/$s" >/dev/null 2>&1; then
  src="$PWD/dist/$s-v1.0.0.zip"; mkdir -p "$PWD/dist"
  git -C "work/$s" archive --format=zip --prefix="$s-v1.0.0/" -o "$src" HEAD \
    && gh release create v1.0.0 -R "epifive/$s" "$src" --target main --title "$s v1.0.0" \
         --notes "First public release. Download the source zip below. Guide and demo: $home" >/dev/null \
    || echo "warning: public release for $s not created"
fi

gh api "repos/epifive/$s-pro" >/dev/null 2>&1 || gh repo create "epifive/$s-pro" --private --description "$s Pro source (private, sold via epifive.com)" >/dev/null
push "work/$s-pro" "$s-pro"
gh release view "$s-pro-v1.0.0" -R epifive/pro-releases >/dev/null 2>&1 \
  || gh release create "$s-pro-v1.0.0" -R epifive/pro-releases "$zip" --title "EpiFive $s Pro v1.0.0" --notes "First release." >/dev/null

echo "released: $(gh api "repos/epifive/$s" -q '.html_url+" "+.visibility+" "+(.license.spdx_id//"?")') | commit authors: $(gh api "repos/epifive/$s/commits" -q '[.[]|(.commit.author.name)]|unique|join(",")')"
