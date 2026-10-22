import cloudbase from '@cloudbase/js-sdk';
import { registerMySQL } from '@cloudbase/js-sdk/mysql';

window.createCloudBaseApp = (config) => {
  const app = cloudbase.init({
    ...config,
    persistence: 'none',
    auth: { detectSessionInUrl: false },
    ...(config.accessKey ? { accessKey: config.accessKey } : {})
  });
  registerMySQL(app);
  return app;
};
