@description('Base name used for all resources (lowercase, no spaces)')
param appName string = 'pbx'

@description('Azure region')
param location string = resourceGroup().location

@description('Container image to deploy, e.g. myregistry.azurecr.io/pbx:latest')
param containerImage string

@description('PostgreSQL admin username')
param dbAdminUser string = 'pbxadmin'

@secure()
@description('PostgreSQL admin password (min 8 chars, upper+lower+number+symbol)')
param dbAdminPassword string

@secure()
param jwtSecret string

@secure()
param portalJwtSecret string

@secure()
param ariPassword string

@description('Asterisk ARI host (IP or FQDN of your Asterisk server)')
param ariHost string

@description('Asterisk ARI application name')
param ariApp string = 'answering-service'

@description('SMTP host for email delivery')
param smtpHost string = ''

@description('SMTP port')
param smtpPort string = '587'

@description('SMTP username')
param smtpUser string = ''

@secure()
param smtpPassword string = ''

@description('From address for outgoing email')
param smtpFrom string = ''

@description('Twilio Account SID')
param twilioSid string = ''

@secure()
param twilioToken string = ''

@description('Twilio from number')
param twilioFrom string = ''

@description('App public URL (used for password reset links), e.g. https://pbx.example.com')
param appUrl string = ''

// ── Container Registry ────────────────────────────────────────────────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${appName}acr${uniqueString(resourceGroup().id)}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: true }
}

// ── Log Analytics workspace ───────────────────────────────────────────────────
resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Container Apps Environment ────────────────────────────────────────────────
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logWorkspace.properties.customerId
        sharedKey: logWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

// ── Azure Database for PostgreSQL Flexible Server ─────────────────────────────
resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${appName}-pg-${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: dbAdminUser
    administratorLoginPassword: dbAdminPassword
    version: '16'
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource pgFirewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: pgServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: pgServer
  name: 'answering_service'
}

// ── Container App ─────────────────────────────────────────────────────────────
var dbConnStr = 'postgresql://${dbAdminUser}:${dbAdminPassword}@${pgServer.properties.fullyQualifiedDomainName}/answering_service?sslmode=require'

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-app'
  location: location
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        stickySessions: { affinity: 'sticky' }  // required for Socket.io
      }
      registries: [
        {
          server: acr.properties.loginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        { name: 'acr-password', value: acr.listCredentials().passwords[0].value }
        { name: 'jwt-secret', value: jwtSecret }
        { name: 'portal-jwt-secret', value: portalJwtSecret }
        { name: 'db-password', value: dbAdminPassword }
        { name: 'ari-password', value: ariPassword }
        { name: 'smtp-password', value: smtpPassword }
        { name: 'twilio-token', value: twilioToken }
      ]
    }
    template: {
      containers: [
        {
          name: 'app'
          image: containerImage
          resources: { cpu: '0.5', memory: '1Gi' }
          env: [
            { name: 'NODE_ENV',          value: 'production' }
            { name: 'PORT',              value: '3000' }
            { name: 'DATABASE_URL',      value: dbConnStr }
            { name: 'DB_HOST',           value: pgServer.properties.fullyQualifiedDomainName }
            { name: 'DB_PORT',           value: '5432' }
            { name: 'DB_NAME',           value: 'answering_service' }
            { name: 'DB_USER',           value: dbAdminUser }
            { name: 'DB_PASSWORD',       secretRef: 'db-password' }
            { name: 'DB_SSL',            value: 'true' }
            { name: 'JWT_SECRET',        secretRef: 'jwt-secret' }
            { name: 'PORTAL_JWT_SECRET', secretRef: 'portal-jwt-secret' }
            { name: 'ARI_HOST',          value: ariHost }
            { name: 'ARI_PORT',          value: '8088' }
            { name: 'ARI_USER',          value: 'asterisk' }
            { name: 'ARI_PASSWORD',      secretRef: 'ari-password' }
            { name: 'ARI_APP',           value: ariApp }
            { name: 'SMTP_HOST',         value: smtpHost }
            { name: 'SMTP_PORT',         value: smtpPort }
            { name: 'SMTP_SECURE',       value: 'false' }
            { name: 'SMTP_USER',         value: smtpUser }
            { name: 'SMTP_PASSWORD',     secretRef: 'smtp-password' }
            { name: 'SMTP_FROM',         value: smtpFrom }
            { name: 'TWILIO_ACCOUNT_SID',value: twilioSid }
            { name: 'TWILIO_AUTH_TOKEN', secretRef: 'twilio-token' }
            { name: 'TWILIO_FROM_NUMBER',value: twilioFrom }
            { name: 'APP_URL',           value: appUrl }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 3000 }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaling'
            http: { metadata: { concurrentRequests: '50' } }
          }
        ]
      }
    }
  }
}

// ── Outputs ───────────────────────────────────────────────────────────────────
output appUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output acrLoginServer string = acr.properties.loginServer
output postgresHost string = pgServer.properties.fullyQualifiedDomainName
