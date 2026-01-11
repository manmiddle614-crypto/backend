export default {
  testEnvironment: "node",
  transform: {},
  testMatch: ["**/__tests__/**/*.test.js"],
  collectCoverageFrom: ["src/**/*.js", "!src/**/*.test.js", "!src/plugins/config.js"],
  verbose: true
}
