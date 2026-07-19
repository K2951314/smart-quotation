/**
 * ui-helpers.js — 布局度量、移动端工具栏状态。
 *
 * 依赖：state.js
 */

function syncLayoutMetrics() {
  const toolbar = document.querySelector(".toolbar");
  const rootStyle = document.documentElement.style;
  const toolbarHeight = toolbar ? Math.ceil(toolbar.getBoundingClientRect().height) : 0;
  rootStyle.setProperty("--toolbar-stack-height", toolbarHeight + "px");
}

function requestLayoutMetricsSync() {
  if (g_LayoutMetricsFrame) return;
  g_LayoutMetricsFrame = window.requestAnimationFrame(() => { g_LayoutMetricsFrame = null; syncLayoutMetrics(); });
}

function syncMobileActionDockState() {
  const backToTopButton = document.getElementById("btnBackToTop");
  const toolbarActions = document.querySelector(".toolbar-actions");
  if (toolbarActions) toolbarActions.classList.remove("is-stuck");
  syncLayoutMetrics();
  if (backToTopButton) {
    const shouldShowBackTop = window.innerWidth <= 720 && window.scrollY > 260;
    backToTopButton.classList.toggle("is-visible", shouldShowBackTop);
  }
}
