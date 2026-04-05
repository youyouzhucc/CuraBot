# aliyun-demo-app

本地写代码 → 推送到 GitHub → 在阿里云上 `git pull` 并运行。

## 一、在你电脑上（Windows）

### 1. 安装 Node.js

从 [https://nodejs.org](https://nodejs.org) 安装 LTS，安装后确认：

```powershell
node -v
npm -v
```

### 2. 安装依赖并本地运行

```powershell
cd d:\youyouzhu
npm install
npm start
```

浏览器打开 `http://127.0.0.1:3000` 应看到 JSON。

### 3. 初始化 Git 并推送到 GitHub

1. 在 GitHub 网页新建一个空仓库（不要勾选自动添加 README），记下仓库地址，例如：  
   `https://github.com/你的用户名/aliyun-demo-app.git`

2. 在本项目目录执行：

```powershell
cd d:\youyouzhu
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/你的用户名/aliyun-demo-app.git
git push -u origin main
```

若提示登录：可用 **GitHub 网页 → Settings → Developer settings → Personal access tokens** 生成 token，密码处粘贴 token。

（若已配置 SSH，可把 `remote` 改成 `git@github.com:你的用户名/aliyun-demo-app.git`。）

---

## 二、在阿里云 Ubuntu 上

用 `ssh cc@公网IP` 或 `root` 登录后执行（按需把路径、仓库地址改成你的）。

### 1. 安装 Git 与 Node.js

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

### 2. 克隆仓库（二选一）

**HTTPS（简单，需 token）：**

```bash
cd /home/cc
git clone https://github.com/你的用户名/aliyun-demo-app.git
cd aliyun-demo-app
```

提示输入 GitHub 用户名和密码时，**密码填 Personal Access Token**。

**SSH（推荐长期使用）：** 在服务器上生成密钥，把 **公钥** 加到 GitHub → **Settings → SSH and GPG keys**：

```bash
ssh-keygen -t ed25519 -C "aliyun-server"
cat ~/.ssh/id_ed25519.pub
```

然后：

```bash
cd /home/cc
git clone git@github.com:你的用户名/aliyun-demo-app.git
cd aliyun-demo-app
```

### 3. 安装依赖并用 PM2 常驻运行

```bash
npm install
sudo npm install -g pm2
pm2 start server.js --name aliyun-demo
pm2 save
pm2 startup
```

按 `pm2 startup` 提示执行一条 `sudo` 命令，保证重启后自动拉起。

### 4. 阿里云防火墙放行端口

控制台 → 轻量应用服务器 → 你的实例 → **防火墙** → 添加规则：**TCP 3000**（或你以后改用 80 再改 Nginx）。

浏览器访问：`http://你的公网IP:3000`

---

## 三、以后改代码怎么更新

**电脑上：** 修改代码 → `git add` → `git commit` → `git push`

**服务器上：**

```bash
cd /home/cc/aliyun-demo-app
git pull
npm install
pm2 restart aliyun-demo
```

---

## 四、可选：用 80 端口 + Nginx 反代（域名访问更常见）

```bash
sudo apt install -y nginx
```

配置 `/etc/nginx/sites-available/default` 里 `location /` 反代到 `http://127.0.0.1:3000`，防火墙放行 **80 / 443**，域名 A 记录指向服务器公网 IP。

---

## 安全提示

- 不要把 **GitHub token**、**服务器密码** 写进代码或提交到仓库。
- 仓库里的 `.gitignore` 已忽略 `.env`；有密钥请只用环境变量或服务器本地配置。
