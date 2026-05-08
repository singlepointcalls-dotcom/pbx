using './main.bicep'

// Fill in all values before first deploy.
// Secrets (marked @secure) should be passed via --parameters or Azure Key Vault references,
// NOT stored in this file.

param appName = 'pbx'
param location = 'uksouth'  // change to your preferred region

// Set at deploy time:
//   param containerImage = 'pbxacr<uid>.azurecr.io/pbx:latest'
//   param dbAdminPassword = ...  (use: az deployment group create --parameters dbAdminPassword=...)
//   param jwtSecret = ...
//   param portalJwtSecret = ...
//   param ariPassword = ...
//   param smtpPassword = ...
//   param twilioToken = ...

param dbAdminUser = 'pbxadmin'
param ariHost     = '10.0.0.1'   // IP/hostname of your Asterisk server
param ariApp      = 'answering-service'
param smtpHost    = 'smtp.example.com'
param smtpPort    = '587'
param smtpUser    = 'notifications@example.com'
param smtpFrom    = 'Answering Service <notifications@example.com>'
param twilioFrom  = '+441234567890'
param appUrl      = 'https://pbx.example.com'  // update after first deploy
