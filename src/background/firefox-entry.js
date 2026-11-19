// Firefox（MV2 持久后台页）入口。
// 后台页自带 DOM，引擎（offscreen.js）直接在本上下文运行，
// rpc.js 的本地路由让后台对引擎的调用绕过消息总线直调。
// 顺序：先注册引擎 handler，再启动后台编排。
import '../offscreen/offscreen.js';
import './service-worker.js';
