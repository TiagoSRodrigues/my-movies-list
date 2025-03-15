#!/bin/bash

# Exit on error
set -e

# Print commands before executing
set -x

# Create main project directory
mkdir -p aws-movie-portal
cd aws-movie-portal

# Create GitHub workflows directory
mkdir -p .github/workflows

# Create CDK directory structure
mkdir -p cdk/bin cdk/lib cdk/test

# Create backend directory structure
mkdir -p backend/functions/api backend/functions/auth backend/functions/processing
mkdir -p backend/graphql/schema backend/graphql/resolvers
mkdir -p backend/step-functions

# Create frontend directory structure
mkdir -p frontend/public frontend/amplify
mkdir -p frontend/src/components frontend/src/graphql frontend/src/hooks frontend/src/pages frontend/src/utils

# Create scripts directory
mkdir -p scripts

# Create local processor directory
mkdir -p local-processor

# Create docs directory
mkdir -p docs

# Initialize package.json files
touch cdk/package.json
touch frontend/package.json
touch local-processor/package.json

# Create main README.md file
touch README.md

# Create placeholder files for key components
touch cdk/bin/app.ts
touch cdk/lib/movie-portal-stack.ts
touch cdk/tsconfig.json
touch backend/graphql/schema/schema.graphql
touch backend/functions/api/index.js
touch backend/functions/processing/process-movie.js
touch backend/step-functions/movie-processing-workflow.json
touch frontend/src/App.js
touch frontend/src/index.js
touch local-processor/index.js
touch docs/architecture.md

echo "Project structure created successfully!"
cd ..

# Create appropriate .gitignore file
cat > aws-movie-portal/.gitignore << EOL
# Dependencies
node_modules/
.pnp/
.pnp.js

# Testing
coverage/

# Production
build/
dist/
cdk.out/

# Misc
.DS_Store
.env
.env.local
.env.development.local
.env.test.local
.env.production.local
.idea/
.vscode/

npm-debug.log*
yarn-debug.log*
yarn-error.log*

# AWS
.aws-sam/
.cdk.staging/
cdk.context.json

# Terraform
.terraform/
terraform.tfstate
terraform.tfstate.backup

# Amplify
.amplify/
amplify/

# CloudFormation
*.template.yaml
EOL

echo "Project initialization complete!"