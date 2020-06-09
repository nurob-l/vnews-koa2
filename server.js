const fs = require('fs')
const path = require('path')
const LRU = require('lru-cache')
// const express = require('express')
const Koa = require('koa')
const Router = require('koa-router')
const koaStatic = require('koa-static')
const mount = require('koa-mount')
// const favicon = require('serve-favicon')
const favicon = require('koa-favicon')
// const compression = require('compression')
const compress = require('koa-compress')
// const microcache = require('route-cache')
const koaCash = require('koa-cash')
const resolve = file => path.resolve(__dirname, file)
const {
  createBundleRenderer
} = require('vue-server-renderer')
const axios = require('axios');
const websiteConfig = require('./src/config/website');

const isProd = process.env.NODE_ENV === 'production'
const useMicroCache = process.env.MICRO_CACHE !== 'false'
const serverInfo =
  `express/${require('express/package.json').version} ` +
  `vue-server-renderer/${require('vue-server-renderer/package.json').version}`

const app = new Koa()
const router = new Router()

function createRenderer(bundle, options) {
  // https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
  return createBundleRenderer(bundle, Object.assign(options, {
    // for component caching
    cache: LRU({
      max: 1000,
      maxAge: 1000 * 60 * 15
    }),
    // this is only needed when vue-server-renderer is npm-linked
    basedir: resolve('./dist'),
    // recommended for performance
    runInNewContext: false
  }))
}

let renderer
let readyPromise
const templatePath = resolve('./src/index.template.html')
if (isProd) {
  // In production: create server renderer using template and built server bundle.
  // The server bundle is generated by vue-ssr-webpack-plugin.
  const template = fs.readFileSync(templatePath, 'utf-8')
  const bundle = require('./dist/vue-ssr-server-bundle.json')
  // The client manifests are optional, but it allows the renderer
  // to automatically infer preload/prefetch links and directly add <script>
  // tags for any async chunks used during render, avoiding waterfall requests.
  const clientManifest = require('./dist/vue-ssr-client-manifest.json')
  renderer = createRenderer(bundle, {
    template,
    clientManifest
  })
} else {
  // In development: setup the dev server with watch and hot-reload,
  // and create a new renderer on bundle / index template update.
  readyPromise = require('./build/setup-dev-server')(
    app,
    templatePath,
    (bundle, options) => {
      console.log('bundle callback..');
      renderer = createRenderer(bundle, options)
    }
  )
}

// const serve = (path, cache) => express.static(resolve(path), {
//     maxAge: cache && isProd ? 1000 * 60 * 60 * 24 * 30 : 0
// })
const serve = (path, cache) => koaStatic(resolve(path), {
  maxAge: cache && isProd ? 1000 * 60 * 60 * 24 * 30 : 0
})

// app.use(compression({threshold: 0}))
app.use(compress({
  threshold: 0
}))
app.use(favicon('./public/logo-48.png'))
// app.use('/dist', serve('./dist', true))
// app.use('/public', serve('./public', true))
// app.use('/manifest.json', serve('./manifest.json', true))
// app.use('/service-worker.js', serve('./dist/service-worker.js'))
app.use(mount('/dist', serve('./dist', true)))
app.use(mount('/public', serve('./public', true)))
app.use(mount('/manifest.json', serve('./manifest.json', true)))
app.use(mount('/service-worker.js', serve('./dist/service-worker.js', true)))

// since this app has no user-specific content, every page is micro-cacheable.
// if your app involves user-specific content, you need to implement custom
// logic to determine whether a request is cacheable based on its url and
// headers.
// 1-second microcache.
// https://www.nginx.com/blog/benefits-of-microcaching-nginx/
// app.use(microcache.cacheSeconds(1, req => useMicroCache && req.originalUrl))
const pageCache = new LRU({
  maxAge: 1000 // global max age
})
app.use(koaCash({
  hash(ctx) {
    return useMicroCache && ctx.response.url // same as ctx.url
  },
  get(key, maxAge) {
    return pageCache.get(key)
  },
  set(key, value) {
    pageCache.set(key, value)
  }
}))

// function render(req, res) {
//     const s = Date.now()

//     res.setHeader("Content-Type", "text/html")
//     res.setHeader("Server", serverInfo)

//     const handleError = err => {
//         if (err.url) {
//             res.redirect(err.url)
//         } else if (err.code === 404) {
//             res.status(404).send('404 | Page Not Found')
//         } else {
//             // Render Error Page or Redirect
//             res.status(500).send('500 | Internal Server Error')
//             console.error(`error during render : ${req.url}`)
//             console.error(err.stack)
//         }
//     }

//     const context = {
//         title: '掘金 - koa', // default title
//         url: req.url
//     }
//     renderer.renderToString(context, (err, html) => {
//         if (err) {
//             return handleError(err)
//         }
//         res.send(html)
//         if (!isProd) {
//             console.log(`whole request: ${Date.now() - s}ms`)
//         }
//     })
// }
async function render(ctx) {
  const s = Date.now()

  ctx.res.setHeader("Content-Type", "text/html")
  ctx.res.setHeader("Server", serverInfo)

  const handleError = err => {
    if (err.url) {
      ctx.res.redirect(err.url)
    } else if (err.code === 404) {
      ctx.response.status = 404
      ctx.response.body = '404 | Page Not Found'
    } else {
      // Render Error Page or Redirect
      ctx.response.status = 500
      ctx.response.body = '500 | Internal Server Error'
      console.error(`error during render : ${ctx.req.url}`)
      console.error(err.stack)
    }
  }

  const context = {
    title: '掘金 - koa', // default title
    url: ctx.req.url
  }
  try {
    const html = await renderer.renderToString(context)
    ctx.res.body = html
    if (!isProd) {
      console.log(`whole request: ${Date.now() - s}ms`)
    }
  } catch (err) {
    return handleError(err)
  }
}

// app.get('/v1/get_entry_by_rank', (req, res) => {
//     console.log(req.url);
//     axios({
//         method:'get',
//         url: websiteConfig.host + req.url,
//         responseType:'stream'
//     }).then(response => {
//         // console.log(response);
//         response.data.pipe(res);
//     }).catch(err => {
//         console.error(err);
//         res.status(500).send('500 | Internal Server Error')
//     });
// });
router.get('/v1/get_entry_by_rank', async (ctx, next) => {
  if (await ctx.cashed()) return
  console.log(ctx.req.url)
  axios({
    method: 'get',
    url: websiteConfig.host + ctx.req.url,
    responseType: 'stream'
  }).then(response => {
    response.data.pipe(ctx.res);
  }).catch(err => {
    console.error(err)
    ctx.res.status(500).send('500 | Internal Server Error')
  });
})

// app.get('*', isProd ? render : (req, res) => {
//     readyPromise.then(() => render(req, res))
// })
router.get('(.*)', async (ctx, next) => {
  if (await ctx.cashed()) return
  if (isProd) {
    await render(ctx)
  } else {
    await readyPromise
    await render(ctx)
  }
})

app.use(router.routes())
app.use(router.allowedMethods())

const port = process.env.PORT || 8081;
app.listen(port, () => {
  console.log(`server started at localhost:${port}`)
})
