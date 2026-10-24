#!/bin/sh
# 修上游镜像里 add_version 造成的多一层目录。
#
# tabby-web 的 manage.py add_version 会用 fsspec 的 put() 把构建期的临时目录整个塞进
# 版本目录下一层，所以镜像里实际的布局是：
#
#   /app-dist/1.0.187-nightly.1/tmpXXXXXXXX/{tabby-core,tabby-ssh,tabby-terminal,...}
#
# 而 /api/1/versions（backend/tabby/app/api/app_version.py 的 _get_version）只列版本目录的
# 一级子目录，于是它把 tmpXXXXXXXX 当成插件名返回给前端，前端按
# /app-dist/<ver>/<plugin>/... 去加载 tabby-core / tabby-ssh 全部 404，界面起不来。
#
# 这里把 tmpXXXXXXXX 里的内容提到版本目录下并删掉空壳，使其变成：
#
#   /app-dist/1.0.187-nightly.1/{tabby-core,tabby-ssh,tabby-terminal,...}
#
# 幂等：第二次跑时已经找不到 tmp* 目录，什么都不做。
# 之所以放成单独的文件而不是写在 lzc-manifest.yml 的 setup_script 里，是因为 manifest 在
# 部署阶段会做 ${VAR} 渲染，含着 $v / $d 的脚本写在里面容易被误当成变量引用；content/ 下的
# 文件按原样打进 LPK，不会经过渲染。

set -u

found=0
for version_dir in /app-dist/*/; do
    [ -d "$version_dir" ] || continue
    for tmp_dir in "$version_dir"tmp*/; do
        [ -d "$tmp_dir" ] || continue
        found=1
        # 用 -f / -d 都覆盖的拷贝方式：先 mv 内容，mv 失败（空目录）就忽略
        mv "$tmp_dir"* "$version_dir" 2>/dev/null || true
        # 顺带处理点文件（add_version 目前不会产生，留个保险）
        mv "$tmp_dir".* "$version_dir" 2>/dev/null || true
        rmdir "$tmp_dir" 2>/dev/null || true
    done
done

if [ "$found" = "1" ]; then
    echo "[fix-app-dist] flattened:"
    for d in /app-dist/*/; do
        echo "  - ${d}"
    done
else
    echo "[fix-app-dist] nothing to do"
fi

# Install the native plugin in every packaged Tabby version, before API discovery.
for version_dir in /app-dist/*/; do
    [ -d "$version_dir/tabby-core" ] || continue
    cp -R /lzcapp/pkg/content/tabby-lightos "$version_dir/"
done
python /lzcapp/pkg/content/patch-ssh.py || exit 1
exit 0
