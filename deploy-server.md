# GitHub 方式部署到服务器

不要把服务器密码或 GitHub token 发给 AI。下面命令在你自己的终端执行。

## 1. 本地推送到 GitHub

在本地项目目录：

```powershell
cd C:\Users\047\Documents\合约
git add server.js package.json package-lock.json public .gitignore README.md deploy-server.md start-dashboard.ps1 start-dashboard.cmd
git commit -m "Add market data dashboard"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<你的仓库>.git
git push -u origin main
```

如果已经有 remote：

```powershell
git remote set-url origin https://github.com/<你的用户名>/<你的仓库>.git
git push -u origin main
```

## 2. 服务器拉取

登录服务器后：

```bash
cd /opt
git clone https://github.com/<你的用户名>/<你的仓库>.git market-dashboard
cd market-dashboard
npm install --omit=dev
PORT=8787 npm start
```

## 3. 后台运行

```bash
npm install -g pm2
cd /opt/market-dashboard
PORT=8787 pm2 start server.js --name market-dashboard
pm2 save
```

## 4. 更新

以后本地改完推送后，在服务器：

```bash
cd /opt/market-dashboard
git pull
npm install --omit=dev
pm2 restart market-dashboard
```
