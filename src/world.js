const { readFileSync } = require('fs');
const { isAbsolute, join, resolve } = require('path');
const { parse: parseUrl } = require('url');
const request = require('superagent');
const SwaggerParser = require('swagger-parser');

const agents = new Map();
const responseCache = new Map();
const getResponseCacheKey = (path, method, status) => `${path};${method};${status}`;

let apiSepc = null;

/** @module World */

/**
 * State and stateful utilities can be shared between steps using an instance of "World"
 */
class World {
    constructor(...params) {
        this._req = null;
        this._currentAgent = null;

        this.defaultContentType = 'application/json';

        // Provide a base url for all relative paths.
        // Using a variable: `{base}/foo` is preferred though
        this._baseUrl = process.env.BASE_URL || '';

        const envFile = process.env.ENV_FILE || null;
        this.envVars = envFile ? JSON.parse(readFileSync(resolve(process.cwd(), envFile))).values : [];
        this.responseVars = [];
    }

    /**
     * Getter for the `baseUrl` used for all requests
     */
    get baseUrl() {
        return this._baseUrl;
    }

    /**
     * Getter for the currently active Superagent request object
     */
    get req() {
        return this._req;
    }

    /**
     * Setter for the active request
     */
    set req(val) {
        // TODO: make this configurable
        val.timeout({ response: 60000, deadline: 90000 });
        this._req = val;
    }

    /**
     * Getter for the curren Superagent agent.
     * Reuse this agent in step definitions to preserve client sessions
     */
    get currentAgent() {
        if (!this._currentAgent) {
            this._currentAgent = request.agent();
        }
        return this._currentAgent;
    }

    /**
     * Getter for the full Open API spec
     */
    get apiSpec() {
        if (!apiSepc) {
            throw new Error('No API spec is loaded. This assertion cannot be performed.')
        }
        return apiSepc;
    }

    /**
     * Get part of the Open API spec for just a single endpoint (resource + method)
     */
    async getEndpointSpec() {
        const { url, method } = this.req;
        let { pathname } = parseUrl(url);

        // FIXME:
        // if  variables have not been replaced yet in the url, parseurl will screw up
        // and not parse the pathname correctly. E.g.
        // "{base}/my-path" becomes "%7Bbase%7Dmy-path"
        // This is a workaround for now:
        if (!pathname.startsWith('/')) {
            pathname = `/${pathname.split('/')[1]}`;
        }

        try {
            return this.apiSpec.paths[pathname][method.toLowerCase()];
        } catch (err) {
            console.warn(err.message);
            return {};
        }
    }
    /**
     * Returns Super Agent middleware that replaces placeholders with
     * variables
     */
    replaceVariablesInitiator() {
        function simpleReplace(val, regex, vars) {
            if (!val) {
                return val;
            }

            // cheeky way to easily replace on whole objects:
            return JSON.parse(JSON.stringify(val).replace(regex, (match, p1) => {
                const matchPair = vars.find(pair => pair.key === p1);
                return matchPair ? matchPair.value : match;
            }));
        }

        return req => {
            const vars = [].concat(this.responseVars).concat(this.envVars);
            if (!vars.length) {
                return req;
            }
            const placeHolders = vars.map(pair => pair.key).join('|');
            const placeHolderRegex = new RegExp(`\{(${placeHolders})\}`, 'g');
            req.url = simpleReplace(req.url, placeHolderRegex, vars);
            req.qs = simpleReplace(req.qs, placeHolderRegex, vars);
            req.headers = simpleReplace(req.headers, placeHolderRegex, vars);
            req.cookies = simpleReplace(req.cookies, placeHolderRegex, vars);
            req._data = simpleReplace(req._data, placeHolderRegex, vars);
            return req;
        };
    }

    /**
     * Get a Superagent agent for a specific authorization role
     * @param {string} role The role, such as 'admin'
     */
    getAgentByRole(role) {
        return agents.get(role);
    }

    /**
     * Save a Superagent agent for a given authorization role
     * @param {string} role
     * @param {*} agent
     */
    setAgentByRole(role, agent) {
        this.currentAgent = agent;
        agents.set(role, agent);
    }

    /**
     * Gets the body from a response. Includes logic to parse
     * JSON from JSON responses that have an incorrect 'text/html' content type.
     * @param {} res A Superagent response object
     */
    getResponseBody(res) {
        if (res.header['content-type'] && res.header['content-type'].startsWith('text/html')) {
            return JSON.parse(res.text);
        }
        return res.body;
    }

    /**
     * Save the current response so its values can be used for future requests
     */
    async saveCurrentResponse() {
        const res = await this.req;
        const { url, method } = this.req;
        const status = res.status.toString();
        const cacheKey = getResponseCacheKey(parseUrl(url).pathname, method, status);
        responseCache.set(cacheKey, this.getResponseBody(res));
    }

    /**
     * Retrieve a response cached by `saveCurrentResponse`
     * @param {} resource An HTTP resource
     * @param {*} method An HTTP method
     * @param {*} status The response status, defaults to 200
     */
    retrieveResponse(resource, method, status = 200) {
        return responseCache.get(getResponseCacheKey(resource, method, status));
    }
}

function resetVars() {
    this.responseVars = [];
}

async function loadApiSpec() {
    // load an open api spec
    const specFile = process.env.API_SPEC_FILE || null;
    if (specFile) {
        const specFilePath = isAbsolute(specFile) ? specFile : join(process.cwd(), specFile);
        try {
            apiSepc = await SwaggerParser.validate(specFilePath);
        } catch (err) {
            console.warn(err.message);
        }
    }
}

module.exports = {
    World,
    registerHooks: function ({ BeforeAll, Before }) {
        BeforeAll(loadApiSpec);
        Before(resetVars);
    }
}
