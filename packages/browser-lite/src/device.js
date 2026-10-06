const assign = require('@bugsnag/core/lib/es-utils/assign')

/*
 * Automatically detects browser device details.
 *
 * This is a privacy-preserving replacement for @bugsnag/plugin-browser-device:
 * it does not generate or persist an anonymous id, and it does not populate a
 * default user id from the device. It also reports the viewport size so the
 * window size is known.
 */
module.exports = (nav = navigator, win = window) => ({
  load: (client) => {
    const device = {
      locale: nav.browserLanguage || nav.systemLanguage || nav.userLanguage || nav.language,
      userAgent: nav.userAgent
    }

    if (win && win.screen && win.screen.orientation && win.screen.orientation.type) {
      device.orientation = win.screen.orientation.type
    } else if (win && win.document) {
      device.orientation =
        win.document.documentElement.clientWidth > win.document.documentElement.clientHeight
          ? 'landscape'
          : 'portrait'
    }

    if (win && typeof win.innerWidth === 'number') device.windowWidth = win.innerWidth
    if (win && typeof win.innerHeight === 'number') device.windowHeight = win.innerHeight

    // add the device details and the time just as the event is sent
    client.addOnError((event) => {
      event.device = assign({}, event.device, device, { time: new Date() })
    }, true)
  }
})
