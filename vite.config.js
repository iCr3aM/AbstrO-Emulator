import { defineConfig } from 'vite';

/**
 * 构建配置：为「SFTP 上传到任意子目录」而设计
 * ===============================================================
 * 1. `base: './'`
 *    ⚠️ **这是白屏的根因修复。** 默认 `base` 是 `/`，产物里会写成
 *    `<script src="/assets/index.js">` —— 绝对路径。一旦用 SFTP 传到
 *    `https://example.com/my-game/` 这种子目录，浏览器会去
 *    `https://example.com/assets/index.js` 找文件 → 404 → 白屏。
 *    改成相对路径后，传到根目录、子目录、甚至本地双击打开都能跑。
 *
 * 2. 文件名**不带哈希**
 *    固定成 `assets/index.js` / `assets/index.css`，这样 SFTP 覆盖上传时
 *    不需要先删旧文件，也不会留下一堆历史哈希文件。
 *
 * 3. 那「缓存怎么办」？
 *    不带哈希 + 固定文件名 = 浏览器可能一直用旧 JS。
 *    解法是 **构建后用 `tools/postbuild.mjs` 给资源 URL 加上 `?v=<构建时间>`**：
 *    文件名不变（方便覆盖上传），但 URL 每次都不同（强制刷新缓存）。
 *    同时产物里会带 `version.json`，页面运行时会比对版本并提示刷新。
 */
/**
 * 构建时剥掉 `index.html` 里的 **HTML 注释**。
 * ===============================================================
 * Vite 会剥 bundle（JS/CSS）里的注释，但**不会碰 `index.html` 的 `<!-- ... -->`** ——
 * 源码里那两段解释「为什么 favicon 要内联」「为什么弹窗层必须在 #app 之外」的注释，
 * 会**原样**出现在 `dist/index.html` 里被推上线（用户 2026-09-27 实测到 2 处）。
 *
 * 处理原则：**源码里保留，产物里删掉**。
 * 注释是写给改代码的人看的，不是写给玩家的；上线的是 dist，不是 src。
 * 所以这里只在 `apply: 'build'` 生效 —— `npm run dev` 时你仍然能在源码里看到它们。
 *
 * `order: 'post'` 让它排在 Vite 自己的 HTML 变换之后、`tools/postbuild.mjs` 之前
 * （postbuild 是在 `vite build` 整体结束后才读盘的，天然在后）。
 * 正则顺带吃掉注释**所在的那一整行**，避免产物里留下空行。
 * `<!--` 不可能出现在 favicon 的 data URI 里（那里 `<` 已编码成 `%3C`），所以不会误伤。
 */
function stripHtmlComments() {
  return {
    name: 'strip-html-comments',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: html => html.replace(/[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n?/g, ''),
    },
  };
}

export default defineConfig({
  base: './',

  plugins: [stripHtmlComments()],

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2019',

    // 不要把小资源内联成 base64：保持文件可被单独覆盖上传、便于排查
    assetsInlineLimit: 0,

    /**
     * 关掉 modulepreload 的 polyfill。
     * 我们没有任何动态 import（全部静态导入），这个 polyfill 是纯负担：
     * 它会在 bundle 最前面立刻执行 `document.querySelectorAll` + `new MutationObserver`，
     * 既增加启动开销，也让「构建产物启动验证」需要多打两个桩。
     */
    modulePreload: { polyfill: false },

    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },

  server: {
    port: 5173,
    host: true,          // 允许局域网/手机访问，方便真机测移动端
    strictPort: false,
  },

  preview: {
    port: 4173,
    host: true,
  },
});
