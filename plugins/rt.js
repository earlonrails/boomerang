/*
 * Copyright (c) 2011, Yahoo! Inc.  All rights reserved.
 * Copyright (c) 2012, Log-Normal, Inc.  All rights reserved.
 * Copyrights licensed under the BSD License. See the accompanying LICENSE.txt file for terms.
 */

// This is the Round Trip Time plugin.  Abbreviated to RT
// the parameter is the window
(function(w) {

/*eslint no-underscore-dangle:0*/

var d=w.document, impl;

BOOMR = BOOMR || {};
BOOMR.plugins = BOOMR.plugins || {};

// private object
impl = {
	onloadfired: false,	//! Set when the page_ready event fires
				//  Use this to determine if unload fires before onload
	unloadfired: false,	//! Set when the first unload event fires
				//  Use this to make sure we don't beacon twice for beforeunload and unload
	visiblefired: false,	//! Set when page becomes visible (Chrome/IE)
				//  Use this to determine if user bailed without opening the tab
	initialized: false,	//! Set when init has completed to prevent double initialization
	complete: false,	//! Set when this plugin has completed

	timers: {},		//! Custom timers that the developer can use
				// Format for each timer is { start: XXX, end: YYY, delta: YYY-XXX }
	cookie: "RT",		//! Name of the cookie that stores the start time and referrer
	cookie_exp:600,		//! Cookie expiry in seconds
	strict_referrer: true,	//! By default, don't beacon if referrers don't match.
				// If set to false, beacon both referrer values and let
				// the back end decide

	navigationType: 0,	// Navigation Type from the NavTiming API.  We mainly care if this was BACK_FORWARD
				// since cookie time will be incorrect in that case
	navigationStart: undefined,
	responseStart: undefined,
	t_start: undefined,	// t_start that came off the cookie
	cached_t_start: undefined,	// cached value of t_start once we know its real value
	t_fb_approx: undefined,	// approximate first byte time for browsers that don't support navtiming
	r: undefined,		// referrer from the cookie
	r2: undefined,		// referrer from document.referer

	// These timers are added directly as beacon variables
	basic_timers: { t_done: 1, t_resp: 1, t_page: 1},

	/**
	 * Merge new cookie `params` onto current cookie, and set `timer` param on cookie to current timestamp
	 * @param params object containing keys & values to merge onto current cookie.  A value of `undefined`
	 *		 will remove the key from the cookie
	 * @param timer  string key name that will be set to the current timestamp on the cookie
	 *
	 * @returns true if the cookie was updated, false if the cookie could not be set for any reason
	 */
	updateCookie: function(params, timer) {
		var t_end, t_start, subcookies, k;

		// Disable use of RT cookie by setting its name to a falsy value
		if(!this.cookie) {
			return false;
		}

		subcookies = BOOMR.utils.getSubCookies(BOOMR.utils.getCookie(this.cookie)) || {};

		if (typeof params === "object") {
			for(k in params) {
				if(params.hasOwnProperty(k)) {
					if (params[k] === undefined ) {
						if (subcookies.hasOwnProperty(k)) {
							delete subcookies[k];
						}
					}
					else {
						if (k==="nu" || k==="r") {
							params[k] = BOOMR.utils.hashQueryString(params[k], true);
						}

						subcookies[k] = params[k];
					}
				}
			}
		}

		t_start = new Date().getTime();

		if(timer) {
			subcookies[timer] = t_start;
		}

		BOOMR.debug("Setting cookie (timer=" + timer + ")\n" + BOOMR.utils.objectToString(subcookies), "rt");
		if(!BOOMR.utils.setCookie(this.cookie, subcookies, this.cookie_exp)) {
			BOOMR.error("cannot set start cookie", "rt");
			return false;
		}

		t_end = new Date().getTime();
		if(t_end - t_start > 50) {
			// It took > 50ms to set the cookie
			// The user Most likely has cookie prompting turned on so
			// t_start won't be the actual unload time
			// We bail at this point since we can't reliably tell t_done
			BOOMR.utils.removeCookie(this.cookie);

			// at some point we may want to log this info on the server side
			BOOMR.error("took more than 50ms to set cookie... aborting: "
					+ t_start + " -> " + t_end, "rt");
		}

		return true;
	},

	/**
	 * Read initial values from cookie and clear out cookie values it cares about after reading.
	 * This makes sure that other pages (eg: loaded in new tabs) do not get an invalid cookie time.
	 * This method should only be called from init, and may be called more than once.
	 *
	 * Request start time is the greater of last page beforeunload or last click time
	 * If start time came from a click, we check that the clicked URL matches the current URL
	 * If it came from a beforeunload, we check that cookie referrer matches document.referrer
	 *
	 * If we had a pageHide time or unload time, we use that as a proxy for first byte on non-navtiming
	 * browsers.
	 */
	initFromCookie: function() {
		var url, subcookies;
		subcookies = BOOMR.utils.getSubCookies(BOOMR.utils.getCookie(this.cookie));

		if(!subcookies) {
			return;
		}

		subcookies.s = Math.max(+subcookies.ul||0, +subcookies.cl||0);

		BOOMR.debug("Read from cookie " + BOOMR.utils.objectToString(subcookies), "rt");

		// If we have a start time, and either a referrer, or a clicked on URL,
		// we check if the start time is usable
		if(subcookies.s && (subcookies.r || subcookies.nu)) {
			this.r = subcookies.r;
			url = BOOMR.utils.hashQueryString(d.URL, true);

			// Either the URL of the page setting the cookie needs to match document.referrer
			BOOMR.debug(this.r + " =?= " + this.r2, "rt");

			// Or the start timer was no more than 15ms after a click or form submit
			// and the URL clicked or submitted to matches the current page's URL
			// (note the start timer may be later than click if both click and beforeunload fired
			// on the previous page)
			BOOMR.debug(subcookies.s + " <? " + (+subcookies.cl+15), "rt");
			BOOMR.debug(subcookies.nu + " =?= " + url, "rt");

			if (!this.strict_referrer ||
				(subcookies.nu && subcookies.nu === url && subcookies.s < +subcookies.cl + 15) ||
				(subcookies.s === +subcookies.ul && this.r === this.r2)
			) {
				this.t_start = subcookies.s;

				// additionally, if we have a pagehide, or unload event, that's a proxy
				// for the first byte of the current page, so use that wisely
				if(+subcookies.hd > subcookies.s) {
					this.t_fb_approx = parseInt(subcookies.hd, 10);
				}
			}
			else {
				this.t_start = this.t_fb_approx = undefined;
			}
		}

		// Now that we've pulled out the timers, we'll clear them so they don't pollute future calls
		this.updateCookie({
			s: undefined,	// start timer
			r: undefined,	// referrer
			nu: undefined,	// clicked url
			ul: undefined,	// onbeforeunload time
			cl: undefined,	// onclick time
			hd: undefined	// onunload or onpagehide time
		});
	},

	/**
	 * Figure out how long boomerang and config.js took to load using resource timing if available, or built in timestamps
	 */
	getBoomerangTimings: function() {
		var res, k, urls, url;
		if(BOOMR.t_start) {
			// How long does it take Boomerang to load up and execute (fb to lb)?
			BOOMR.plugins.RT.startTimer("boomerang", BOOMR.t_start);
			BOOMR.plugins.RT.endTimer("boomerang", BOOMR.t_end);	// t_end === null defaults to current time

			// How long did it take from page request to boomerang fb?
			BOOMR.plugins.RT.endTimer("boomr_fb", BOOMR.t_start);

			if(BOOMR.t_lstart) {
				// when did the boomerang loader start loading boomerang on the page?
				BOOMR.plugins.RT.endTimer("boomr_ld", BOOMR.t_lstart);
				// What was the network latency for boomerang (request to first byte)?
				BOOMR.plugins.RT.setTimer("boomr_lat", BOOMR.t_start - BOOMR.t_lstart);
			}
		}

		// use window and not w because we want the inner iframe
		try
		{
			if (window.performance && window.performance.getEntriesByName) {
				urls = { "rt.bmr." : BOOMR.url };

				for(url in urls) {
					if(urls.hasOwnProperty(url) && urls[url]) {
						res = window.performance.getEntriesByName(urls[url]);
						if(!res || res.length === 0) {
							continue;
						}
						res = res[0];

						for(k in res) {
							if(res.hasOwnProperty(k) && k.match(/(Start|End)$/) && res[k] > 0) {
								BOOMR.addVar(url + k.replace(/^(...).*(St|En).*$/, "$1$2"), res[k]);
							}
						}
					}
				}
			}
		}
		catch(e)
		{
			BOOMR.addError(e, "rt.getBoomerangTimings");
		}
	},

	/**
	 * Check if we're in a prerender state, and if we are, set additional timers.
	 * In Chrome/IE, a prerender state is when a page is completely rendered in an in-memory buffer, before
	 * a user requests that page.  We do not beacon at this point because the user has not shown intent
	 * to view the page.  If the user opens the page, the visibility state changes to visible, and we
	 * fire the beacon at that point, including any timing details for prerendering.
	 *
	 * Sets the `t_load` timer to the actual value of page load time (request initiated by browser to onload)
	 *
	 * @returns true if this is a prerender state, false if not (or not supported)
	 */
	checkPreRender: function() {
		if(
			!(d.visibilityState && d.visibilityState === "prerender")
			&&
			!(d.msVisibilityState && d.msVisibilityState === 3)
		) {
			return false;
		}

		// This means that onload fired through a pre-render.  We'll capture this
		// time, but wait for t_done until after the page has become either visible
		// or hidden (ie, it moved out of the pre-render state)
		// http://code.google.com/chrome/whitepapers/pagevisibility.html
		// http://www.w3.org/TR/2011/WD-page-visibility-20110602/
		// http://code.google.com/chrome/whitepapers/prerender.html

		BOOMR.plugins.RT.startTimer("t_load", this.navigationStart);
		BOOMR.plugins.RT.endTimer("t_load");					// this will measure actual onload time for a prerendered page
		BOOMR.plugins.RT.startTimer("t_prerender", this.navigationStart);
		BOOMR.plugins.RT.startTimer("t_postrender");				// time from prerender to visible or hidden

		BOOMR.subscribe("visibility_changed", BOOMR.plugins.RT.done, "visible", BOOMR.plugins.RT);

		return true;
	},

	/**
	 * Initialise timers from the NavigationTiming API.  This method looks at various sources for
	 * Navigation Timing, and also patches around bugs in various browser implementations.
	 * It sets the beacon parameter `rt.start` to the source of the timer
	 */
	initFromNavTiming: function() {
		var ti, p, source;

		if(this.navigationStart) {
			return;
		}

		// Get start time from WebTiming API see:
		// https://dvcs.w3.org/hg/webperf/raw-file/tip/specs/NavigationTiming/Overview.html
		// http://blogs.msdn.com/b/ie/archive/2010/06/28/measuring-web-page-performance.aspx
		// http://blog.chromium.org/2010/07/do-you-know-how-slow-your-web-page-is.html
		p = w.performance || w.msPerformance || w.webkitPerformance || w.mozPerformance;

		if(p && p.navigation) {
			this.navigationType = p.navigation.type;
		}

		if(p && p.timing) {
			ti = p.timing;
		}
		else if(w.chrome && w.chrome.csi && w.chrome.csi().startE) {
			// Older versions of chrome also have a timing API that's sort of documented here:
			// http://ecmanaut.blogspot.com/2010/06/google-bom-feature-ms-since-pageload.html
			// source here:
			// http://src.chromium.org/viewvc/chrome/trunk/src/chrome/renderer/loadtimes_extension_bindings.cc?view=markup
			ti = {
				navigationStart: w.chrome.csi().startE
			};
			source = "csi";
		}
		else if(w.gtbExternal && w.gtbExternal.startE()) {
			// The Google Toolbar exposes navigation start time similar to old versions of chrome
			// This would work for any browser that has the google toolbar installed
			ti = {
				navigationStart: w.gtbExternal.startE()
			};
			source = "gtb";
		}

		if(ti) {
			// Always use navigationStart since it falls back to fetchStart (not with redirects)
			// If not set, we leave t_start alone so that timers that depend
			// on it don't get sent back.  Never use requestStart since if
			// the first request fails and the browser retries, it will contain
			// the value for the new request.
			BOOMR.addVar("rt.start", source || "navigation");
			this.navigationStart = ti.navigationStart || ti.fetchStart || undefined;
			this.responseStart = ti.responseStart || undefined;

			// bug in Firefox 7 & 8 https://bugzilla.mozilla.org/show_bug.cgi?id=691547
			if(navigator.userAgent.match(/Firefox\/[78]\./)) {
				this.navigationStart = ti.unloadEventStart || ti.fetchStart || undefined;
			}
		}
		else {
			BOOMR.warn("This browser doesn't support the WebTiming API", "rt");
		}

		return;
	},

	/**
	 * Set timers appropriate at page load time.  This method should be called from done() only when
	 * the page_ready event fires.  It sets the following timer values:
	 *		- t_resp:	time from request start to first byte
	 *		- t_page:	time from first byte to load
	 *		- t_postrender	time from prerender state to visible state
	 *		- t_prerender	time from navigation start to visible state
	 *
	 * @param t_done The timestamp when the done() method was called
	 *
	 * @returns true if timers were set, false if we're in a prerender state, caller should abort on false.
	 */
	setPageLoadTimers: function(t_done) {
		impl.initFromCookie();
		impl.initFromNavTiming();

		if(impl.checkPreRender()) {
			return false;
		}

		if(impl.responseStart) {
			// Use NavTiming API to figure out resp latency and page time
			// t_resp will use the cookie if available or fallback to NavTiming
			BOOMR.plugins.RT.endTimer("t_resp", impl.responseStart);
			if(impl.timers.t_load) {	// t_load is the actual time load completed if using prerender
				BOOMR.plugins.RT.setTimer("t_page", impl.timers.t_load.end - impl.responseStart);
			}
			else {
				BOOMR.plugins.RT.setTimer("t_page", t_done - impl.responseStart);
			}
		}
		else if(impl.timers.hasOwnProperty("t_page")) {
			// If the dev has already started t_page timer, we can end it now as well
			BOOMR.plugins.RT.endTimer("t_page");
		}
		else if(impl.t_fb_approx) {
			BOOMR.plugins.RT.endTimer("t_resp", impl.t_fb_approx);
			BOOMR.plugins.RT.setTimer("t_page", t_done - impl.t_fb_approx);
		}

		// If a prerender timer was started, we can end it now as well
		if(impl.timers.hasOwnProperty("t_postrender")) {
			BOOMR.plugins.RT.endTimer("t_postrender");
			BOOMR.plugins.RT.endTimer("t_prerender");
		}

		return true;
	},

	/**
	 * Writes a bunch of timestamps onto the beacon that help in request tracing on the server
	 * 	- rt.tstart: The value of t_start that we determined was appropriate
	 *	- rt.cstart: The value of t_start from the cookie if different from rt.tstart
	 *	- rt.bstart: The timestamp when boomerang started
	 *	- rt.end:    The timestamp when the t_done timer ended
	 *
	 * @param t_start The value of t_start that we plan to use
	 */
	setSupportingTimestamps: function(t_start) {
		BOOMR.addVar("rt.tstart", t_start);
		if(typeof impl.t_start === "number" && impl.t_start !== t_start) {
			BOOMR.addVar("rt.cstart", impl.t_start);
		}
		BOOMR.addVar("rt.bstart", BOOMR.t_start);
		if (BOOMR.t_lstart) {
			BOOMR.addVar("rt.blstart", BOOMR.t_lstart);
		}
		BOOMR.addVar("rt.end", impl.timers.t_done.end);	// don't just use t_done because dev may have called endTimer before we did
	},

	/**
	 * Determines the best value to use for t_start.
	 * If called from an xhr call, then use the start time for that call
	 * Else, If we have navigation timing, use that
	 * Else, If we have a cookie time, and this isn't the result of a BACK button, use the cookie time
	 * Else, if we have a cached timestamp from an earlier call, use that
	 * Else, give up
	 *
	 * @param ename	 The event name that resulted in this call. Special consideration for "xhr"
	 * @param pgname If the event name is "xhr", this should be the page group name for the xhr call
	 *
	 * @returns the determined value of t_start or undefined if unknown
	 */
	determineTStart: function(ename, pgname) {
		var t_start;
		if(ename==="xhr" && pgname && impl.timers[pgname]) {
			// For xhr timers, t_start is stored in impl.timers.xhr_{page group name}
			// and xhr.pg is set to {page group name}
			t_start = impl.timers[pgname].start;
			BOOMR.addVar("rt.start", "manual");
		}
		else if(impl.navigationStart) {
			t_start = impl.navigationStart;
		}
		else if(impl.t_start && impl.navigationType !== 2) {
			t_start = impl.t_start;			// 2 is TYPE_BACK_FORWARD but the constant may not be defined across browsers
			BOOMR.addVar("rt.start", "cookie");	// if the user hit the back button, referrer will match, and cookie will match
		}						// but will have time of previous page start, so t_done will be wrong
		else if(impl.cached_t_start) {
			t_start = impl.cached_t_start;
		}
		else {
			BOOMR.addVar("rt.start", "none");
			t_start = undefined;			// force all timers to NaN state
		}

		BOOMR.debug("Got start time: " + t_start, "rt");
		impl.cached_t_start = t_start;

		return t_start;
	},

	page_ready: function() {
		// we need onloadfired because it's possible to reset "impl.complete"
		// if you're measuring multiple xhr loads, but not possible to reset
		// impl.onloadfired
		this.onloadfired = true;
	},

	visibility_changed: function() {
		// we care if the page became visible at some point
		if(!(d.hidden || d.msHidden || d.webkitHidden)) {
			impl.visiblefired = true;
		}
	},

	page_unload: function(edata) {
		BOOMR.debug("Unload called with " + BOOMR.utils.objectToString(edata) + " when unloadfired = " + this.unloadfired, "rt");
		if(!this.unloadfired) {
			// run done on abort or on page_unload to measure session length
			BOOMR.plugins.RT.done(edata, "unload");
		}

		// set cookie for next page
		// We use document.URL instead of location.href because of a bug in safari 4
		// where location.href is URL decoded
		this.updateCookie({ "r": d.URL }, edata.type === "beforeunload"?"ul":"hd");

		this.unloadfired = true;
	},

	_iterable_click: function(name, element, etarget, value_cb) {
		var value;
		if(!etarget) {
			return;
		}
		BOOMR.debug(name + " called with " + etarget.nodeName, "rt");
		while(etarget && etarget.nodeName.toUpperCase() !== element) {
			etarget = etarget.parentNode;
		}
		if(etarget && etarget.nodeName.toUpperCase() === element) {
			BOOMR.debug("passing through", "rt");
			// user event, they may be going to another page
			// if this page is being opened in a different tab, then
			// our unload handler won't fire, so we need to set our
			// cookie on click or submit
			value = value_cb(etarget);
			this.updateCookie({ "nu": value }, "cl" );
			BOOMR.addVar("nu", BOOMR.utils.cleanupURL(value));
		}
	},

	onclick: function(etarget) {
		impl._iterable_click("Click", "A", etarget, function(t) { return t.href; });
	},

	onsubmit: function(etarget) {
		impl._iterable_click("Submit", "FORM", etarget, function(t) { var v = t.action || d.URL || ""; return v.match(/\?/) ? v : v + "?"; });
	},

	domloaded: function() {
		BOOMR.plugins.RT.endTimer("t_domloaded");
	}
};

BOOMR.plugins.RT = {
	// Methods

	init: function(config) {
		BOOMR.debug("init RT", "rt");
		if(w !== BOOMR.window) {
			w = BOOMR.window;
			d = w.document;
		}

		BOOMR.utils.pluginConfig(impl, config, "RT",
					["cookie", "cookie_exp", "strict_referrer"]);

		// A beacon may be fired automatically on page load or if the page dev fires
		// it manually with their own timers.  It may not always contain a referrer
		// (eg: XHR calls).  We set default values for these cases.
		// This is done before reading from the cookie because the cookie overwrites
		// impl.r
		impl.r = impl.r2 = BOOMR.utils.hashQueryString(d.referrer, true);

		// Now pull out start time information from the cookie
		// We'll do this every time init is called, and every time we call it, it will
		// overwrite values already set (provided there are values to read out)
		impl.initFromCookie();

		// We'll get BoomerangTimings every time init is called because it could also
		// include additional timers which might happen on a subsequent init call.
		impl.getBoomerangTimings();

		// only initialize once.  we still collect config and check/set cookies
		// every time init is called, but we attach event handlers only once
		if(impl.initialized) {
			return this;
		}

		impl.complete = false;
		impl.timers = {};

		BOOMR.subscribe("page_ready", impl.page_ready, null, impl);
		impl.visiblefired = !(d.hidden || d.msHidden || d.webkitHidden);
		if(!impl.visiblefired) {
			BOOMR.subscribe("visibility_changed", impl.visibility_changed, null, impl);
		}
		BOOMR.subscribe("page_ready", this.done, "load", this);
		BOOMR.subscribe("xhr_load", this.done, "xhr", this);
		BOOMR.subscribe("dom_loaded", impl.domloaded, null, impl);
		BOOMR.subscribe("page_unload", impl.page_unload, null, impl);
		BOOMR.subscribe("click", impl.onclick, null, impl);
		BOOMR.subscribe("form_submit", impl.onsubmit, null, impl);
		BOOMR.subscribe("before_beacon", this.addTimersToBeacon, "beacon", this);

		impl.initialized = true;
		return this;
	},

	startTimer: function(timer_name, time_value) {
		if(timer_name) {
			if (timer_name === "t_page") {
				this.endTimer("t_resp", time_value);
			}
			impl.timers[timer_name] = {start: (typeof time_value === "number" ? time_value : new Date().getTime())};
		}

		return this;
	},

	endTimer: function(timer_name, time_value) {
		if(timer_name) {
			impl.timers[timer_name] = impl.timers[timer_name] || {};
			if(impl.timers[timer_name].end === undefined) {
				impl.timers[timer_name].end =
						(typeof time_value === "number" ? time_value : new Date().getTime());
			}
		}

		return this;
	},

	setTimer: function(timer_name, time_delta) {
		if(timer_name) {
			impl.timers[timer_name] = { delta: time_delta };
		}

		return this;
	},

	addTimersToBeacon: function(vars, source) {
		var t_name, timer,
		    t_other=[];

		for(t_name in impl.timers) {
			if(impl.timers.hasOwnProperty(t_name)) {
				timer = impl.timers[t_name];

				// if delta is a number, then it was set using setTimer
				// if not, then we have to calculate it using start & end
				if(typeof timer.delta !== "number") {
					if(typeof timer.start !== "number") {
						timer.start = impl.cached_t_start;
					}
					timer.delta = timer.end - timer.start;
				}

				// If the caller did not set a start time, and if there was no start cookie
				// Or if there was no end time for this timer,
				// then timer.delta will be NaN, in which case we discard it.
				if(isNaN(timer.delta)) {
					continue;
				}

				if(impl.basic_timers.hasOwnProperty(t_name)) {
					BOOMR.addVar(t_name, timer.delta);
				}
				else {
					t_other.push(t_name + "|" + timer.delta);
				}
			}
		}

		if (t_other.length) {
			BOOMR.addVar("t_other", t_other.join(","));
		}

		if (source === "beacon") {
			impl.timers = {};
			impl.complete = false;	// reset this state for the next call
		}
	},

	// Called when the page has reached a "usable" state.  This may be when the
	// onload event fires, or it could be at some other moment during/after page
	// load when the page is usable by the user
	done: function(edata, ename) {
		BOOMR.debug("Called done with " + BOOMR.utils.objectToString(edata) + ", " + ename, "rt");
		var t_start, t_done=new Date().getTime(),
		    subresource = false;

		impl.complete = false;

		if(ename==="load" || ename==="visible") {
			if (!impl.setPageLoadTimers(t_done)) {
				return this;
			}
		}

		if(ename === "xhr" && edata && edata.data) {
			subresource = edata.data.subresource;
		}

		t_start = impl.determineTStart(ename, edata ? edata.name : null);

		// If the dev has already called endTimer, then this call will do nothing
		// else, it will stop the page load timer
		this.endTimer("t_done", t_done);

		// make sure old variables don't stick around
		BOOMR.removeVar(
			"t_done", "t_page", "t_resp", "t_postrender", "t_prerender", "t_load", "t_other",
			"r", "r2", "rt.tstart", "rt.cstart", "rt.bstart", "rt.end", "rt.subres", "rt.abld"
		);

		impl.setSupportingTimestamps(t_start);

		this.addTimersToBeacon();

		if(ename !== "xhr") {
			BOOMR.addVar("r", BOOMR.utils.cleanupURL(impl.r));

			if(impl.r2 !== impl.r) {
				BOOMR.addVar("r2", BOOMR.utils.cleanupURL(impl.r2));
			}
		}

		if(subresource) {
			BOOMR.addVar("rt.subres", 1);
		}
		impl.updateCookie();

		if(ename==="unload") {
			BOOMR.addVar("rt.quit", "");

			if(!impl.onloadfired) {
				BOOMR.addVar("rt.abld", "");
			}

			if(!impl.visiblefired) {
				BOOMR.addVar("rt.ntvu", "");
			}
		}

		impl.complete = true;

		BOOMR.sendBeacon();

		return this;
	},

	is_complete: function() { return impl.complete; }

};

}(window));
// End of RT plugin


