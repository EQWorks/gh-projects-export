const { Octokit } = require('@octokit/core')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const isBetween = require('dayjs/plugin/isBetween')
dayjs.extend(utc)
dayjs.extend(isBetween)

const { GITHUB_TOKEN, GITHUB_ORG = 'EQWorks' } = process.env
const octokit = new Octokit({ auth: GITHUB_TOKEN })

const getProjectID = ({ login = GITHUB_ORG, number = 16 } = {}) => octokit.graphql(
  `
    query project($login: String!, $number: Int!) {
      organization(login: $login) {
        projectV2(number: $number) {
          id
        }
      }
    }
  `,
  {
    login,
    number,
  },
)

const getProjectItems = async (id) => {
  let data = []
  let hasNextPage = true
  let endCursor = null
  while (hasNextPage) {
    const { node: { items: { pageInfo = {}, nodes = [] } = {} } = {} } = await octokit.graphql(
      `
        query($id: ID!, $after: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(
                first: 100
                orderBy: {direction: DESC, field: POSITION}
                after: $after
              ) {
                pageInfo {
                  endCursor
                  hasNextPage
                }
                nodes {
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldIterationValue {
                        title
                        startDate
                        duration
                        field {
                          ... on ProjectV2IterationField {
                            name
                          }
                        }
                      }
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2SingleSelectField {
                            name
                          }
                        }
                      }
                    }
                  }
                  content{
                    ...on Issue {
                      __typename
                      title
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                      state
                      number
                    }
                    ...on PullRequest {
                      __typename
                      title
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                      state
                      number
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        id,
        after: endCursor,
      },
    )
    data = data.concat(nodes)
    hasNextPage = pageInfo.hasNextPage
    endCursor = pageInfo.endCursor
  }
  return data
}

const filterItems = (items) => {
  const data = []
  items.forEach(({ fieldValues, content }) => {
    // get the custom fields
    const meta = fieldValues.nodes
      .filter((n) => Object.keys(n).length > 0)
      .reduce((acc, { name: value, field: { name }, ...rest }) => {
        acc[name] = { value, ...rest }
        return acc
      }, {})
    // skip the done ones
    if (meta.Status.value.toLowerCase().endsWith('done')) {
      return
    }
    // skip the ones without an iteration
    if (!meta.Iteration) {
      return
    }
    // skip the ones that aren't a part of the current iteration
    const start = dayjs.utc(meta.Iteration.startDate)
    const end = start.add(meta.Iteration.duration, 'days')
    if (!dayjs.utc().isBetween(start, end)) {
      return
    }
    // parse content
    const { __typename, title, repository: { owner: { login } = {}, name: repo } = {}, number } = content
    if (!repo) { // likely a draft issue
      return
    }
    data.push({
      number,
      type: __typename === 'PullRequest' ? 'PR' : __typename,
      repo: `${login}/${repo}`,
      title,
    })
  })
  return data
}

const toCSV = (data) => {
  const headers = Object.keys(data[0])
  let csv = headers.map((h) => `"${h}"`).join(',') + '\n'
  data.forEach((r) => {
    csv += headers.map((h) => `"${r[h]}"`).join(',') + '\n'
  })
  return csv.trim()
}

;(async () => {
  const id = (await getProjectID())?.organization?.projectV2?.id
  const items = await(getProjectItems(id))
  const data = filterItems(items)
  console.log(toCSV(data))
})()
