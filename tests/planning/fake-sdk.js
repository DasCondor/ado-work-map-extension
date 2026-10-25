// Test stand-in for the Azure DevOps extension SDK. Extension data lives in the test page (top.FAKE_STORE),
// with an __etag that changes on every write, like the real service.
const T = window.top;
export function init() {}
export async function ready() {}
export function notifyLoadSucceeded() {}
export function getWebContext() { return {project: {id: 'p1', name: 'Fabrikam'}, team: {id: 't1', name: 'Web Team'}}; }
export function getHost() { return {name: 'contoso'}; }
export function getExtensionContext() { return {id: 'DasCondor.ado-work-map-boards'}; }
export async function getAccessToken() { return 'fake-token'; }
export async function getService(name) {
  if (name === 'ms.vss-features.location-service') return {getServiceLocation: async () => 'https://dev.azure.com/contoso/'};
  if (name === 'ms.vss-work-web.work-item-form-navigation-service') return {openWorkItem: id => { T.FAKE_OPENED = id; }};
  if (name === 'ms.vss-features.extension-data-service') return {getExtensionDataManager: async () => {
    const S = T.FAKE_STORE = T.FAKE_STORE || {}, log = op => (T.FAKE_DOCS = T.FAKE_DOCS || []).push(op);
    return {
      getDocument: async (c, id) => { if (!S[id]) throw new Error('Document does not exist'); return JSON.parse(JSON.stringify(S[id])); },
      createDocument: async (c, doc) => { log({op: 'create', doc}); if (S[doc.id]) throw new Error('Document already exists');
        return S[doc.id] = Object.assign({}, doc, {__etag: 1}); },
      setDocument: async (c, doc) => { log({op: 'set', doc}); const cur = S[doc.id];
        if (doc.__etag !== -1 && cur && cur.__etag !== doc.__etag) throw new Error('etag mismatch: the document was changed');
        return S[doc.id] = Object.assign({}, doc, {__etag: (cur ? cur.__etag : 0) + 1}); }
    };
  }};
  throw new Error('no service ' + name);
}
