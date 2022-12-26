#!/bin/sh

cd "$(dirname "$(realpath "$0")")"

rm -f resources/CHECKSUM
sha256sum resources/* > resources/CHECKSUM
tar zcvf resources.tar.gz resources
cat>resources.ts<<EOF
export const resourceBlob: string = \`$(base64 < resources.tar.gz)\`
export const resourceHash: string = \`$(cat resources/CHECKSUM)\`
EOF
rm -f resources.tar.gz
npm i
npm run build
