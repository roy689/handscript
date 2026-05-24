module.exports = function (api) {
  // api.env() implicitly configures caching based on BABEL_ENV / NODE_ENV.
  // Calling api.cache(true) here would conflict with api.env() and throw:
  //   "Caching has already been configured with .never or .forever()"
  const isProduction = api.env('production');
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ...(isProduction ? [['transform-remove-console', { exclude: ['error', 'warn'] }]] : []),
    ],
  };
};
