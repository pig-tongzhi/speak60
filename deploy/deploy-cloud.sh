#!/usr/bin/env bash
#
# 把「即兴一分钟」部署到云机器（175.178.41.19）
#
# 访问地址：https://175.178.41.19/speak60/
#
# 本脚本做这些事：
#   1. 上传静态文件到 /data/speak60/
#   2. 幂等地往 nginx 的 purchase-system.conf 里加一个 location ^~ /speak60/
#      （已存在就跳过，不重复添加）
#   3. nginx -t 校验，不通过就自动回滚配置并退出
#   4. reload nginx
#   5. 从本机验证 HTTPS 页面确实返回了正确内容
#
# 用法：
#   ./deploy/deploy-cloud.sh            # 完整部署
#   ./deploy/deploy-cloud.sh --dry-run  # 只上传并在服务器上校验，不改 nginx
#   ./deploy/deploy-cloud.sh --rollback # 用最近一次备份还原 nginx 配置
#
# 注意：不要动根路径 /（那是船舶备件的 SPA），也不要动其它 location。

set -euo pipefail

HOST="175.178.41.19"
KEY="$HOME/.ssh/ajv_purchase_deploy"
SSH="ssh -i $KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"
REMOTE_DIR="/data/speak60"
NGINX_CONF="/etc/nginx/conf.d/purchase-system.conf"
URL_PATH="/speak60/"
SITE_URL="https://$HOST$URL_PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d%H%M%S)"
DRY=0
ROLLBACK=0

for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --rollback) ROLLBACK=1 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  ✓ %s\n' "$*"; }
warn(){ printf '  ! %s\n' "$*"; }

# ---------- 回滚 ----------
if [ "$ROLLBACK" = "1" ]; then
  say "回滚 nginx 配置"
  LATEST="$($SSH root@$HOST "ls -1t /root/nginx-backup/purchase-system.conf.* 2>/dev/null | head -1" 2>/dev/null | tail -1)"
  if [ -z "$LATEST" ]; then
    echo "  没找到备份，放弃"; exit 1
  fi
  $SSH root@$HOST "
    set -e
    cp '$LATEST' '$NGINX_CONF'
    nginx -t && systemctl reload nginx && echo '  已回滚并 reload：$LATEST'
  "
  exit 0
fi

# ---------- 1. 检查要上传的文件都在 ----------
say "1/6 检查本地文件"
cd "$ROOT"
FILES=(index.html palette-preview.html)
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "  缺少 $f"; exit 1; }
done
ok "index.html $(wc -c < index.html | tr -d ' ') 字节"
ok "palette-preview.html $(wc -c < palette-preview.html | tr -d ' ') 字节"
# 确认没有残留的抓取数据文件被上传
if [ -f news-data.js ]; then warn "检测到 news-data.js，将不会上传（该功能已移除）"; fi

# ---------- 2. 建目录并上传 ----------
say "2/6 上传到 $HOST:$REMOTE_DIR"
$SSH root@$HOST "mkdir -p $REMOTE_DIR"
for f in "${FILES[@]}"; do
  rsync -a -e "ssh -i $KEY -o ConnectTimeout=20" "$f" "root@$HOST:$REMOTE_DIR/$f"
done
$SSH root@$HOST "
  set -e
  chown -R root:root $REMOTE_DIR
  chmod -R u=rwX,go=rX $REMOTE_DIR
  echo '  远程文件：'
  ls -l $REMOTE_DIR | sed 's/^/    /'
"
ok "上传完成"

# ---------- 3. 生成 nginx location 片段 ----------
LOCATION_SNIPPET='    # 即兴一分钟（纯静态单文件应用，由 deploy/deploy-cloud.sh 部署）
    location ^~ /speak60/ {
        alias /data/speak60/;
        index index.html;
        try_files $uri $uri/ /speak60/index.html;
        add_header Cache-Control "no-cache" always;
    }
'

if [ "$DRY" = "1" ]; then
  say "3/6 --dry-run：跳过 nginx 改动"
  say "验证（用服务器自身回环请求已上传的文件）"
  $SSH root@$HOST "curl -s -o /dev/null -w '  文件可读，HTTP %{http_code}\n' http://127.0.0.1:8088/ 2>/dev/null || echo '  （回环检查跳过）'"
  echo
  echo "试运行完成。去掉 --dry-run 即正式生效。"
  echo "生效后的地址：$SITE_URL"
  exit 0
fi

# ---------- 4. 备份并写入 nginx 配置 ----------
say "3/6 备份并在 nginx 中登记路径"
$SSH root@$HOST "
  set -e
  mkdir -p /root/nginx-backup
  cp '$NGINX_CONF' /root/nginx-backup/purchase-system.conf.$STAMP
  echo '  已备份：/root/nginx-backup/purchase-system.conf.$STAMP'
"
# 幂等：已包含该 location 就不重复插入
if $SSH root@$HOST "grep -q 'location \^~ /speak60/' '$NGINX_CONF'"; then
  ok "nginx 中已存在 /speak60/ 配置，跳过插入"
else
  # 插到 location /api/ 之前（保持在 server 块内、且不碰根路径 /）
  printf '%s' "$LOCATION_SNIPPET" > /tmp/speak60-location.conf
  rsync -a -e "ssh -i $KEY -o ConnectTimeout=20" /tmp/speak60-location.conf "root@$HOST:/tmp/speak60-location.conf"
  $SSH root@$HOST "
    set -e
    python3 - <<'PY'
conf = '$NGINX_CONF'
snippet = open('/tmp/speak60-location.conf', encoding='utf-8').read()
s = open(conf, encoding='utf-8').read()
if 'location ^~ /speak60/' in s:
    print('  已存在，未改动')
else:
    marker = '    location /api/ {'
    assert marker in s, '找不到插入位置（location /api/）'
    s = s.replace(marker, snippet + '\n' + marker, 1)
    open(conf, 'w', encoding='utf-8').write(s)
    print('  已插入 location ^~ /speak60/')
PY
  "
  ok "配置已写入"
fi

# ---------- 5. 校验后 reload，失败自动回滚 ----------
say "4/6 nginx -t 校验并 reload"
if ! $SSH root@$HOST "nginx -t" 2>&1 | grep -q 'syntax is ok'; then
  warn "nginx 配置校验失败，自动回滚"
  $SSH root@$HOST "cp /root/nginx-backup/purchase-system.conf.$STAMP '$NGINX_CONF' && nginx -t" >/dev/null 2>&1 || true
  echo "  已回滚到部署前配置，未 reload，线上服务未受影响"
  exit 1
fi
ok "配置语法通过"
$SSH root@$HOST "systemctl reload nginx && echo '  nginx 已 reload'"
ok "reload 完成（不中断已有连接）"

# ---------- 6. 从本机验证 ----------
say "5/6 从本机验证"
sleep 1
CODE="$(curl -sS -o /tmp/speak60-live.html -w '%{http_code}' -m 20 -k "$SITE_URL" || echo 000)"
if [ "$CODE" != "200" ]; then
  warn "HTTPS 返回 $CODE，部署可能未生效"
  exit 1
fi
ok "HTTPS $CODE"
if cmp -s /tmp/speak60-live.html "$ROOT/index.html"; then
  ok "线上内容与本地 index.html 一致"
else
  warn "线上内容与本地不一致（可能是缓存），下载到 /tmp/speak60-live.html 供比对"
fi
printf '  HTTP  %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "$SITE_URL")"

# 确认没有影响既有服务
say "6/6 确认既有服务未受影响"
for u in "https://$HOST/" "https://$HOST/help-cat/rescue/" "https://$HOST/ninebot/"; do
  printf '  %-42s HTTP %s\n' "$u" "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -k "$u")"
done

echo
echo "部署完成：$SITE_URL"
echo "回滚：./deploy/deploy-cloud.sh --rollback"
