// create the module and name it userApp
angular.module('userApp')
  .config(function($stateProvider, $urlRouterProvider) {
    $stateProvider
      .state("ipad", {
        url: "/ipad",
        templateUrl: "pages/ipad.html",
        authenticate: true
      })
      .state("tv", {
        url: "/tv",
        templateUrl: "pages/tv.html",
        authenticate: false
      })
      .state("register", {
        url: "/register",
        templateUrl: "pages/register.html",
        authenticate: false
      });
    // Send to login if the URL was not found
    $urlRouterProvider.otherwise("/register");
  })
  .run(function($rootScope, $state, User) {
    $rootScope.$on("$stateChangeStart", function(event, toState, toParams, fromState, fromParams) {
      if (toState.authenticate && !User.loggedin) {
        // User isn’t authenticated
        $state.transitionTo("register");
        event.preventDefault();
      }
    });
  });
